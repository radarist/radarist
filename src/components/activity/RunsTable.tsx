'use client';

/**
 * @file components/activity/RunsTable.tsx
 * @description Agent Runs table (Task 21 / P-F1 part 1) — one row per agent
 * execution (mission, sweep, or build). Replaces the old Live Log / History /
 * Builds tabbed feed on `/agents/runs`. Owns its own card header (title +
 * subtitle + search, CONV-HEADER), sortable columns (SortableHeader, CONV
 * parity with the library tables), and CONV-PAGINATION footer; the page
 * composes the `runs` array from the existing run-history + build-mission +
 * event-stream hooks and hands it down untouched (bespoke feature UI per
 * WS-F — copies the Companies table's `<Table>` markup, not a shared
 * abstraction).
 *
 * ARUN-026: Agent, Kind and Status are accessible multi-select facets in the
 * card header — OR within a facet, AND across facets and the search box.
 * Selection state lives in `useRunsFilters` (shareable URL params, with a
 * uid-scoped saved preference as the fallback); each selected value renders
 * as a removable chip alongside a Reset control. The `?tab=builds[&build=<id>]`
 * deep link (see `AgentRunsSection` in `src/app/agents/runs/page.tsx`) seeds
 * the Kind facet via `initialKindFacet`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { AlertTriangle, Bot, CheckCircle2, ListFilter, Radio, Search, SkipForward, X, XCircle } from 'lucide-react';
import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRunsFilters, type RunsFacet } from '@/hooks/useRunsFilters';
import { formatEnumLabel } from '@/lib/enum-label';
import { formatDuration, formatTokens } from './run-formatters';
import { DataPagination } from '@/components/library/shared/DataPagination';
import {
  ActivityTableCardHeader,
  ActivityTableFrame,
  ActivityTableSearch,
  ActivityTableSortableHead,
  ActivityTableToolbarRow,
  nextSortState,
  type ActivitySortDirection,
} from './activity-table-shell';
import { EmptyState } from '@/components/feedback/EmptyState';
import { cn } from '@/lib/utils';
import type { AgentRunProvider } from '@/lib/schemas/agent-run';
import { formatRunCost } from '@/lib/run-cost-display';
import { formatAgentIdentityLabel } from '@/lib/build-runtime-identity';

// ============================================================================
// TYPES (public interface contract)
// ============================================================================

export type AgentRunKind = 'chat' | 'mission' | 'sweep' | 'build';
// AUDIT-006 — `blocked` is a build parked at a HUMAN gate (budget top-up / stall /
// approval). It is deliberately NOT a flavour of `live`: the supervisor is stopped
// at `step.waitForEvent` and will auto-deny after 24h if nobody acts, so a Live pill
// would tell the reader "working" about a run that is waiting on THEM.
export type AgentRunStatus = 'live' | 'blocked' | 'success' | 'failure' | 'skipped';
export type AgentRunL1Verdict = 'PASS' | 'REVISE' | 'FAIL';

export interface AgentRunQuality {
  passed: number;
  total: number;
  score: number;
  l1: AgentRunL1Verdict;
}

export interface AgentRunRow {
  id: string;
  agent: string;
  provider?: AgentRunProvider;
  model?: string;
  mission: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  quality?: AgentRunQuality;
  /** Visible accounting authority for this row; undefined on live/SSE-only rows. */
  costUsd?: number;
  costState?: 'estimated' | 'settled' | 'mixed' | 'reserved' | 'maximum-exposure';
  costUnavailable?: boolean;
  /**
   * ARUN-027 — why the cost is not stated, so "we could not price this" stays
   * distinguishable from "our ledger lost receipts for real spend".
   */
  costUnavailableReason?: 'unknown-pricing' | 'accounting-incomplete';
  /** Undefined when no token count was persisted for the run (ARUN-007) — rendered as "—". */
  tokens: number | undefined;
  /**
   * ARUN-020 — the token total is a proven LOWER BOUND: at least one provider
   * response in the run reported no usage at all. The number is real, it is
   * just not the whole turn, so the cell marks it rather than reading exact.
   */
  tokensPartiallyReported?: boolean;
  /**
   * ARUN-020 — the total is a RUNNING figure for a mission still in flight, not
   * a terminal one. Real, durable, and still moving.
   */
  tokensProvisional?: boolean;
  /** Undefined when the duration is unknowable (ARUN-008 fallback rows) — rendered as "—". */
  durationMs: number | undefined;
  /** ISO 8601 — rendered as an absolute date (CONV-DATE), never relative. */
  startedAt: string;
}

type KindFacet = 'all' | AgentRunKind;

/** Sortable columns (Task 24 / P-F8) — all 9 visible columns, wired via the
 * shared `SortableHeader`. Client-side sort over the already-assembled rows. */
type RunSortField = 'mission' | 'agent' | 'kind' | 'status' | 'quality' | 'tokens' | 'cost' | 'duration' | 'started';
type SortDirection = ActivitySortDirection;

interface RunsTableProps {
  runs: AgentRunRow[];
  onRowClick: (id: string) => void;
  /**
   * Whether rows render as clickable (cursor-pointer) and actually invoke
   * `onRowClick`. Defaults to true. Set to `false` for a non-navigating
   * embedding of this table (the `/agents/runs` page itself always passes
   * a real `onRowClick` that pushes to the run detail route, P-F1 pt2).
   */
  clickable?: boolean;
  /**
   * Seeds the Kind facet on mount — powers the `/agents/runs?tab=builds`
   * deep link emitted by artifact/assessment pages. Defaults to 'all'.
   * ARUN-026: it surfaces as a removable chip beside the Kind facet menu,
   * applies only when nothing is already selected, and is NOT saved to the
   * account preference (arriving via a link is not the operator choosing a
   * filter).
   */
  initialKindFacet?: KindFacet;
  /**
   * Highlights (`bg-muted/50`) and scrolls this row into view on mount if
   * it's present in `runs` — powers the `&build=<id>` half of the same
   * deep link.
   */
  highlightRunId?: string;
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

/** Absolute date for record tables (CONV-DATE) — never relative. */
function formatStartedAt(iso: string): string {
  try {
    return format(new Date(iso), 'MMM d, yyyy');
  } catch {
    return '—';
  }
}

// ============================================================================
// PILLS (CONV-BADGE)
// ============================================================================

/** Agent name — classification, so a neutral outline pill (never tinted). */
function AgentPill({ agent }: { agent: string }) {
  return (
    <Badge variant="outline" className="gap-1 text-xs font-normal capitalize">
      <Bot className="h-3 w-3" />
      {/* ARUN-030: build work is attributed to the build RUNTIME, not to a
          research profile that never ran. The raw id would render as
          "Build-runtime" under the `capitalize` class and read like another
          profile name. */}
      {formatAgentIdentityLabel(agent)}
    </Badge>
  );
}

/** Exported for reuse by the run detail page (`/agents/runs/[id]`) Details card. */
export const KIND_LABEL: Record<AgentRunKind, string> = {
  chat: 'Chat',
  mission: 'Mission',
  sweep: 'Sweep',
  build: 'Build',
};

/** Plural label for the dismissible "Kind: …" chip (P-F8) — matches the
 * wording of the removed kind facet `Select`'s options. */
const KIND_FACET_LABEL: Record<AgentRunKind, string> = {
  chat: 'Chats',
  mission: 'Missions',
  sweep: 'Sweeps',
  build: 'Builds',
};

/** Stable facet-menu ordering, independent of which runs happen to be loaded. */
const KIND_FACET_ORDER: AgentRunKind[] = ['chat', 'mission', 'sweep', 'build'];
const STATUS_FACET_ORDER: AgentRunStatus[] = ['live', 'blocked', 'success', 'failure', 'skipped'];

const FACET_LABEL: Record<RunsFacet, string> = { agents: 'Agent', kinds: 'Kind', statuses: 'Status' };
const FACET_CHIP_ORDER: RunsFacet[] = ['agents', 'kinds', 'statuses'];

/**
 * Chip text for a selected value. An unrecognized value (a retired kind, an
 * agent that no longer runs) keeps its raw form: it filters to nothing, and
 * showing it verbatim is what lets the reader see why and remove it.
 */
function facetValueLabel(facet: RunsFacet, value: string): string {
  if (facet === 'kinds') return KIND_FACET_LABEL[value as AgentRunKind] ?? value;
  if (facet === 'statuses') return STATUS_META[value as AgentRunStatus]?.label ?? value;
  return formatEnumLabel(value);
}

interface FacetMenuProps {
  facet: RunsFacet;
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (facet: RunsFacet, value: string) => void;
}

/** Accessible multi-select facet — Radix supplies the menu/checkbox roles. */
function FacetMenu({ facet, label, options, selected, onToggle }: FacetMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5"
          data-testid={`runs-${facet}-filter`}
          aria-label={`Filter by ${label.toLowerCase()}`}
          disabled={options.length === 0}
        >
          <ListFilter className="h-3.5 w-3.5" />
          {label}
          {selected.length > 0 && (
            <Badge variant="secondary" className="ml-0.5 h-5 min-w-5 justify-center px-1 text-[11px]">
              {selected.length}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(facet, option.value)}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Run kind — classification, so a neutral outline pill (never tinted).
 * Exported for reuse by the run detail page (`/agents/runs/[id]`) chips row.
 */
export function KindPill({ kind }: { kind: AgentRunKind }) {
  return (
    <Badge variant="outline" className="text-xs font-normal">
      {KIND_LABEL[kind]}
    </Badge>
  );
}

const STATUS_META: Record<AgentRunStatus, { label: string; icon: React.ElementType; className: string }> = {
  live: {
    label: 'Live',
    icon: Radio,
    className: 'bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400',
  },
  blocked: {
    label: 'Needs you',
    icon: AlertTriangle,
    className: 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400',
  },
  success: {
    label: 'Success',
    icon: CheckCircle2,
    className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400',
  },
  failure: {
    label: 'Failed',
    icon: XCircle,
    className: 'bg-destructive/10 text-destructive border-destructive/30',
  },
  skipped: {
    label: 'Skipped',
    icon: SkipForward,
    className: 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400',
  },
};

/**
 * Run status — a state, so a tinted outline pill per CONV-BADGE.
 * Exported for reuse by the run detail page (`/agents/runs/[id]`) chips row.
 */
export function StatusPill({ status }: { status: AgentRunStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={cn('gap-1 text-xs font-normal', meta.className)}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

const L1_CLASS: Record<AgentRunL1Verdict, string> = {
  PASS: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400',
  REVISE: 'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400',
  FAIL: 'bg-destructive/10 text-destructive border-destructive/30',
};

/** Exported for reuse by the run detail page (`/agents/runs/[id]`) chips row. */
export function L1Pill({ verdict }: { verdict: AgentRunL1Verdict }) {
  return (
    <Badge variant="outline" className={cn('shrink-0 px-1.5 py-0 text-[10px] font-medium', L1_CLASS[verdict])}>
      L1 {verdict}
    </Badge>
  );
}

/**
 * ARUN-012 — flags a run detail view assembled from an INCOMPLETE set of
 * sources: at least one of history / build / event-history fetches failed, so
 * the record shown (status, step log, tokens) may be missing pieces. Distinct
 * from the run's own status: a run can be a genuine "Success" and still render
 * partial if its event history couldn't be loaded. Amber, matching the
 * "Needs you" / "Skipped" convention.
 */
export function PartialPill() {
  return (
    <Badge
      variant="outline"
      data-testid="run-partial-pill"
      title="Some of this run's data couldn't be loaded — the details below may be incomplete."
      className={cn(
        'gap-1 text-xs font-normal',
        'bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400'
      )}
    >
      <AlertTriangle className="h-3 w-3" />
      Partial
    </Badge>
  );
}

/**
 * ARUN-027 — the cost cell. Wording comes from the ONE shared rule
 * (`formatRunCost`) so the table, run detail, and Activity log cannot drift, and
 * so `Unpriced` (no rate-card entry) stays distinct from `Incomplete` (the
 * ledger lost receipts for real spend). The `title` carries the full
 * explanation, since the cell itself has room for one word.
 */
function RunCostCell({ run }: { run: AgentRunRow }) {
  const cost = formatRunCost(run);
  return <span title={cost.title}>{cost.label}</span>;
}

function QualityCell({ quality }: { quality?: AgentRunQuality }) {
  if (!quality) return <span className="text-muted-foreground/40">—</span>;
  return (
    <div className="flex items-center gap-2">
      <span className="whitespace-nowrap text-sm text-muted-foreground">
        {quality.passed}/{quality.total} · {quality.score}%
      </span>
      <L1Pill verdict={quality.l1} />
    </div>
  );
}

// ============================================================================
// SORTING (Task 24 / P-F8) — client-side sort over the already-assembled
// `runs` array. Ascending comparators; the table negates for 'desc'.
// ============================================================================

/** Missing quality (no report yet) sorts as the lowest possible score. */
function compareRuns(a: AgentRunRow, b: AgentRunRow, field: RunSortField): number {
  switch (field) {
    case 'mission':
      return a.mission.localeCompare(b.mission);
    case 'agent':
      return a.agent.localeCompare(b.agent);
    case 'kind':
      return KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]);
    case 'status':
      return STATUS_META[a.status].label.localeCompare(STATUS_META[b.status].label);
    case 'quality':
      return (a.quality?.score ?? -1) - (b.quality?.score ?? -1);
    case 'tokens':
      return (a.tokens ?? -1) - (b.tokens ?? -1); // unknown sorts first/last consistently
    case 'cost':
      return (a.costUsd ?? -1) - (b.costUsd ?? -1);
    case 'duration':
      return (a.durationMs ?? -1) - (b.durationMs ?? -1); // unknown sorts first/last consistently
    case 'started':
      return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
  }
}

/**
 * Agent-Runs binding of the shared `ActivityTableSortableHead` — same shell as
 * the Jobs table, with this surface's `runs-sort-*` test ids.
 */
function SortableHead(props: {
  label: string;
  field: RunSortField;
  currentField: RunSortField;
  currentDirection: SortDirection;
  onSort: (field: RunSortField) => void;
  className?: string;
  align?: 'left' | 'right';
}) {
  return <ActivityTableSortableHead<RunSortField> {...props} testIdPrefix="runs-sort" />;
}

// ============================================================================
// ROW
// ============================================================================

function RunRow({
  run,
  onRowClick,
  clickable,
  highlighted = false,
}: {
  run: AgentRunRow;
  onRowClick: (id: string) => void;
  clickable: boolean;
  highlighted?: boolean;
}) {
  const rowRef = useRef<HTMLTableRowElement>(null);

  // Deep-link target (?build=<id>) — scroll it into view once on mount /
  // once it becomes the highlighted row (e.g. filters change and it
  // (re)appears on the current page).
  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [highlighted]);

  return (
    <TableRow
      ref={rowRef}
      className={cn(
        'border-b border-border/40 transition-colors hover:bg-accent/30',
        clickable ? 'cursor-pointer' : 'cursor-default',
        highlighted && 'bg-muted/50'
      )}
      onClick={clickable ? () => onRowClick(run.id) : undefined}
      data-testid={`run-row-${run.id}`}
    >
      <TableCell className="w-full max-w-0 px-4 py-3">
        <span className="block truncate" title={run.mission} data-testid={`run-mission-${run.id}`}>
          {run.mission}
        </span>
      </TableCell>
      <TableCell className="px-4 py-3">
        <div className="space-y-1">
          <AgentPill agent={run.agent} />
          {run.kind === 'chat' && (run.provider || run.model) && (
            <div className="max-w-[180px] truncate text-xs text-muted-foreground" data-testid={`run-model-${run.id}`}>
              {run.provider ? (run.provider === 'claude' ? 'Claude' : 'Gemini') : 'Unknown provider'}
              {run.model ? ` · ${run.model}` : ''}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden px-4 py-3 sm:table-cell">
        <KindPill kind={run.kind} />
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusPill status={run.status} />
      </TableCell>
      <TableCell className="hidden px-4 py-3 md:table-cell">
        <QualityCell quality={run.quality} />
      </TableCell>
      <TableCell
        className="hidden px-4 py-3 text-right text-sm text-muted-foreground lg:table-cell"
        data-testid={`run-tokens-${run.id}`}
        title={
          run.tokensPartiallyReported
            ? 'At least one provider response reported no usage — this is a lower bound.'
            : run.tokensProvisional
              ? 'A running total for a mission still in flight — not final.'
              : undefined
        }
      >
        {formatTokens(run.tokens)}
        {run.tokensPartiallyReported && run.tokens !== undefined ? (
          <span className="ml-1 text-xs" data-testid={`run-tokens-partial-${run.id}`}>
            (partial)
          </span>
        ) : run.tokensProvisional && run.tokens !== undefined ? (
          <span className="ml-1 text-xs" data-testid={`run-tokens-running-${run.id}`}>
            (running)
          </span>
        ) : null}
      </TableCell>
      <TableCell
        className="hidden whitespace-nowrap px-4 py-3 text-right text-sm text-muted-foreground lg:table-cell"
        data-testid={`run-cost-${run.id}`}
      >
        <RunCostCell run={run} />
      </TableCell>
      <TableCell className="hidden px-4 py-3 text-right text-sm text-muted-foreground lg:table-cell">
        {formatDuration(run.durationMs)}
      </TableCell>
      <TableCell className="w-[132px] whitespace-nowrap px-4 py-3 text-right text-sm text-muted-foreground">
        {formatStartedAt(run.startedAt)}
      </TableCell>
    </TableRow>
  );
}

// ============================================================================
// RUNS TABLE
// ============================================================================

/**
 * RunsTable
 *
 * Standard table for `/agents/runs` — one row per mission, sweep, or build
 * execution. Owns its own CONV-HEADER card header (title + subtitle left,
 * search right, plus the dismissible kind chip when URL-set), sortable
 * columns, and the CONV-PAGINATION footer internally; the caller only
 * supplies the raw `runs` array plus a row-click handler.
 */
export function RunsTable({
  runs,
  onRowClick,
  clickable = true,
  initialKindFacet = 'all',
  highlightRunId,
}: RunsTableProps) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const { filters, activeCount, toggleValue, setFacet, reset, matches } = useRunsFilters();
  const [sortField, setSortField] = useState<RunSortField>('started');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // `?tab=builds` seeds the Kind facet once. It only applies when nothing is
  // already selected — an explicit `?kind=` or a saved preference is the
  // user's own choice and must not be overwritten by the tab shorthand — and
  // it is NOT persisted: arriving via a deep link is not the operator
  // choosing a filter, and saving it would silently hide their other runs on
  // every later visit.
  const seededKindRef = useRef(false);
  useEffect(() => {
    if (seededKindRef.current) return;
    seededKindRef.current = true;
    if (initialKindFacet !== 'all' && filters.kinds.length === 0) {
      setFacet('kinds', [initialKindFacet], { persist: false });
    }
  }, [initialKindFacet, filters.kinds.length, setFacet]);

  /**
   * Facet options come from the runs actually on screen — offering a value
   * with no rows behind it would imply history that isn't there.
   */
  const facetOptions = useMemo(() => {
    const agents = new Set<string>();
    const kinds = new Set<AgentRunKind>();
    const statuses = new Set<AgentRunStatus>();
    for (const run of runs) {
      agents.add(run.agent);
      kinds.add(run.kind);
      statuses.add(run.status);
    }
    return {
      agents: [...agents].sort((a, b) => a.localeCompare(b)),
      kinds: KIND_FACET_ORDER.filter((kind) => kinds.has(kind)),
      statuses: STATUS_FACET_ORDER.filter((status) => statuses.has(status)),
    };
  }, [runs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((run) => {
      if (!matches(run)) return false;
      if (
        q &&
        ![run.mission, run.agent, run.provider, run.model]
          .filter((value): value is string => typeof value === 'string')
          .some((value) => value.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
  }, [runs, search, matches]);

  const sorted = useMemo(() => {
    const comparable = [...filtered];
    comparable.sort((a, b) => {
      const comparison = compareRuns(a, b, sortField);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return comparable;
  }, [filtered, sortField, sortDirection]);

  // Filters/search changed — the previous page offset may now be past the
  // end of the (smaller) result set, so snap back to page 1. Serialized
  // because `filters` is a fresh object on each facet change.
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    setPageIndex(0);
  }, [search, filterKey]);

  const clearAllFilters = () => {
    setSearch('');
    reset();
  };

  const handleSort = (field: RunSortField) => {
    const next = nextSortState({ field: sortField, direction: sortDirection }, field);
    setSortField(next.field);
    setSortDirection(next.direction);
  };

  const pageRows = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  return (
    <div data-testid="runs-table">
      {/* Card header (CONV-HEADER) — title + muted subtitle left, the three
          ARUN-026 facet menus + search right, one row. Shared with the Jobs
          table via `ActivityTableCardHeader` (UX-068) so both Activity
          surfaces cannot drift; selected values render as removable chips in
          the row below, alongside Reset and the visible/total count. */}
      <ActivityTableCardHeader title="Agent Runs" description="View chat, mission, sweep, and build execution history">
        <FacetMenu
          facet="agents"
          label="Agent"
          options={facetOptions.agents.map((agent) => ({ value: agent, label: formatEnumLabel(agent) }))}
          selected={filters.agents}
          onToggle={toggleValue}
        />
        <FacetMenu
          facet="kinds"
          label="Kind"
          options={facetOptions.kinds.map((kind) => ({ value: kind, label: KIND_FACET_LABEL[kind] }))}
          selected={filters.kinds}
          onToggle={toggleValue}
        />
        <FacetMenu
          facet="statuses"
          label="Status"
          options={facetOptions.statuses.map((status) => ({ value: status, label: STATUS_META[status].label }))}
          selected={filters.statuses}
          onToggle={toggleValue}
        />

        <ActivityTableSearch
          testId="runs-search-input"
          label="Search runs"
          placeholder="Search runs…"
          value={search}
          onChange={setSearch}
        />
      </ActivityTableCardHeader>

      {(activeCount > 0 || search.trim().length > 0) && (
        <ActivityTableToolbarRow>
          {FACET_CHIP_ORDER.map((facet) =>
            filters[facet].map((value) => (
              <button
                key={`${facet}-${value}`}
                type="button"
                onClick={() => toggleValue(facet, value)}
                data-testid={`runs-filter-chip-${facet}-${value}`}
                aria-label={`Remove ${FACET_LABEL[facet]} filter ${facetValueLabel(facet, value)}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {FACET_LABEL[facet]}: {facetValueLabel(facet, value)}
                <X className="h-3 w-3" />
              </button>
            ))
          )}

          {/* The visible count is stated against the UNFILTERED total, so a
              narrowed view can never read as the complete run history. */}
          <span data-testid="runs-filter-summary" className="text-xs text-muted-foreground">
            Showing {filtered.length} of {runs.length} {runs.length === 1 ? 'run' : 'runs'}
          </span>

          {activeCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAllFilters}
              data-testid="runs-filter-reset"
              className="h-7 px-2 text-xs"
            >
              Reset
            </Button>
          )}
        </ActivityTableToolbarRow>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={runs.length === 0 ? Bot : Search}
          title={runs.length === 0 ? 'No agent runs yet' : 'No matching runs'}
          description={
            runs.length === 0
              ? 'Chats, missions, sweeps, and build runs will appear here once agents start executing.'
              : 'Try a different search term.'
          }
          action={
            runs.length === 0
              ? { label: 'Go to Agent Config', onClick: () => router.push('/settings?tab=agent-config') }
              : { label: 'Clear filters', onClick: clearAllFilters }
          }
          size="sm"
        />
      ) : (
        <>
          <ActivityTableFrame
            ariaLabel="Agent runs"
            head={
              <>
                <SortableHead
                  label="Run"
                  field="mission"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="w-full"
                />
                <SortableHead
                  label="Agent"
                  field="agent"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                />
                <SortableHead
                  label="Kind"
                  field="kind"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="hidden sm:table-cell"
                />
                <SortableHead
                  label="Status"
                  field="status"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                />
                <SortableHead
                  label="Quality"
                  field="quality"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="hidden md:table-cell"
                />
                <SortableHead
                  label="Tokens"
                  field="tokens"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="hidden lg:table-cell"
                  align="right"
                />
                <SortableHead
                  label="Cost"
                  field="cost"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="hidden lg:table-cell"
                  align="right"
                />
                <SortableHead
                  label="Duration"
                  field="duration"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="hidden lg:table-cell"
                  align="right"
                />
                {/* Fixed width sized for the widest CONV-DATE string
                      ("Dec 31, 2026") + whitespace-nowrap so dates never wrap
                      to two lines at ≤1280 viewports — same fix class as the
                      Task 13 infographics date column; the Mission column's
                      w-full absorbs the rebalance. */}
                <SortableHead
                  label="Started"
                  field="started"
                  currentField={sortField}
                  currentDirection={sortDirection}
                  onSort={handleSort}
                  className="w-[132px] whitespace-nowrap"
                  align="right"
                />
              </>
            }
          >
            <TableBody>
              {pageRows.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  onRowClick={onRowClick}
                  clickable={clickable}
                  highlighted={run.id === highlightRunId}
                />
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
            itemLabel="runs"
          />
        </>
      )}
    </div>
  );
}
