'use client';

/**
 * @file app/triage/assessment/page.tsx
 * @description The Assessment area — a TABLE inbox of every PROACTIVE proposal awaiting
 * approval: net-new entities the scout discovered (proposedEntity), build-mission
 * evaluation verdicts (proposedAssessment), AND artifact RECOMMENDATIONS (produce/update a
 * report / research / infographic — these EXECUTE on approve). Two tabs: Inbox (pending,
 * library-grade — search, sort, multi-select + bulk delete, per-row approve/reject/delete)
 * and Archive (the resolved history — also a full table with search/sort/pagination, plus
 * the produced output link). Header + chrome match the platform tables (Reports/Library).
 * Canonical home of the Assessment implementation — `/agents/assessment` is a
 * legacy redirect stub that forwards here (P-F4, mirrors `/agents/signals`).
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Inbox,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { ErrorBoundary, ErrorFallback } from '@/components/feedback/ErrorBoundary';
import { InboxDegradedBanner } from '@/components/triage/InboxDegradedBanner';
import { useInbox, useInboxArchive } from '@/hooks/useInbox';
import { degradedInboxSources, type InboxRow } from '@/hooks/inbox-rows';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';

const rowKey = (r: InboxRow) => `${r.kind}:${r.id}`;

// CONV-BADGE: classification pill — tinted outline (Badge variant="outline" + semantic
// tint class), matching the recipe used by CompanyStatusBadge / InsightTypeBadge. Previously
// "Discovery" rendered as a filled solid pill (variant="default"), which CONV-BADGE reserves
// for primary action buttons only.
const KIND_META: Record<InboxRow['kind'], { label: string; Icon: typeof Sparkles; tint: string }> = {
  discovery: {
    label: 'Discovery',
    Icon: Sparkles,
    tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  },
  verdict: {
    label: 'Verdict',
    Icon: ClipboardCheck,
    tint: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  },
  recommendation: {
    label: 'Recommendation',
    Icon: FileText,
    tint: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  },
};

// Match the Linker (relations triage) chrome exactly: colored confidence % + status badge.
function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color =
    confidence >= 85
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      : confidence >= 70
        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
        : 'bg-destructive/10 text-destructive';
  return <span className={cn('rounded px-2 py-0.5 text-xs font-medium', color)}>{confidence}%</span>;
}

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending: { label: 'Pending', variant: 'outline' },
  approved: { label: 'Approved', variant: 'default' },
  rejected: { label: 'Rejected', variant: 'destructive' },
  dismissed: { label: 'Dismissed', variant: 'secondary' },
};

function StatusBadge({ status }: { status?: string }) {
  const cfg = STATUS_CONFIG[status ?? 'pending'] ?? STATUS_CONFIG.pending;
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}

/** Absolute created-at date for record tables (CONV-DATE) — never relative. */
function formatCreatedAt(ms?: number): string {
  if (!ms) return '—';
  try {
    return format(new Date(ms), 'MMM d, yyyy');
  } catch {
    return '—';
  }
}

function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="m-4 flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <Inbox className="mb-3 h-8 w-8 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function KindBadge({ kind }: { kind: InboxRow['kind'] }) {
  const m = KIND_META[kind];
  return (
    <Badge variant="outline" className={cn('gap-1 px-2 py-0.5 text-xs font-normal', m.tint)}>
      <m.Icon className="h-3 w-3" />
      {m.label}
    </Badge>
  );
}

/** Status chip for a recommendation's generation (idle/generating/ready/failed). */
function GenChip({ status }: { status?: string }) {
  if (!status || status === 'idle') return null;
  const tone = status === 'ready' ? 'text-emerald-600' : status === 'failed' ? 'text-destructive' : 'text-amber-600';
  return <span className={cn('text-xs', tone)}>{status === 'generating' ? 'generating…' : status}</span>;
}

type SortKey = 'name' | 'kind' | 'confidence';

function useSorter(rows: InboxRow[], search: string, initial: SortKey) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: initial, dir: 'desc' });
  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.entityType.toLowerCase().includes(q))
      : rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'confidence') return (a.confidence - b.confidence) * dir;
      const av = sort.key === 'name' ? a.name : a.kind;
      const bv = sort.key === 'name' ? b.name : b.kind;
      return av.localeCompare(bv) * dir;
    });
  }, [rows, search, sort]);
  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const icon = (key: SortKey) =>
    sort.key !== key ? (
      <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-50" />
    ) : sort.dir === 'asc' ? (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    );
  return { sorted, toggle, icon };
}

function InboxTable({ search }: { search: string }) {
  const router = useRouter();
  const {
    rows,
    isLoading,
    sourceHealth,
    allSourcesFailed,
    retryFailed,
    retriesExhausted,
    busy,
    approve,
    reject,
    dismiss,
  } = useInbox();
  const { sorted, toggle, icon } = useSorter(rows, search, 'confidence');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const sel = useTableSelection<InboxRow>({ getItemId: rowKey });

  const pageRows = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  const { isAllSelected, isSomeSelected } = useSelectionState(sel.selectedIds, pageRows, rowKey);

  const handleBulkDelete = async () => {
    sorted.filter((r) => sel.isSelected(r)).forEach((r) => dismiss(r));
    sel.clearSelection();
  };

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  // UX-053: a FULL outage (all three sources down, nothing to show) is an
  // error panel; anything less degrades in place below so last-good rows stay.
  if (allSourcesFailed && sorted.length === 0) {
    return (
      <div className="p-4">
        <ErrorFallback
          error={new Error('None of the inbox sources are available right now.')}
          reset={retryFailed}
          title="Failed to load the inbox"
          description="Discoveries, verdicts, and report recommendations are all temporarily unavailable. Retry, or reload the page in a moment."
        />
      </div>
    );
  }
  const degraded = degradedInboxSources(sourceHealth);
  if (sorted.length === 0) {
    return (
      <>
        <div className="px-4 pt-4">
          <InboxDegradedBanner sources={degraded} onRetry={retryFailed} retriesExhausted={retriesExhausted} />
        </div>
        <Empty
          title={search ? 'No matches' : 'Nothing to review'}
          description={
            search
              ? 'No proposals match your search.'
              : 'Discoveries, verdicts, and report recommendations land here. Try asking the AI Assistant (Cmd+/): "recommend a report on <topic>" — approval generates it (needs GOOGLE_API_KEY).'
          }
        />
      </>
    );
  }

  return (
    <>
      <div className="px-4 pt-2">
        <InboxDegradedBanner sources={degraded} onRetry={retryFailed} retriesExhausted={retriesExhausted} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40px]">
              <Checkbox
                checked={isAllSelected || (isSomeSelected && 'indeterminate')}
                onCheckedChange={(c) => sel.handleSelectAllChange(!!c, pageRows)}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggle('name')}>
              Name {icon('name')}
            </TableHead>
            <TableHead className="w-[160px] cursor-pointer select-none" onClick={() => toggle('kind')}>
              Type {icon('kind')}
            </TableHead>
            <TableHead>What approving does</TableHead>
            <TableHead
              className="w-[130px] cursor-pointer select-none whitespace-nowrap"
              onClick={() => toggle('confidence')}
            >
              Confidence {icon('confidence')}
            </TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="w-[130px]">Created</TableHead>
            <TableHead className="w-[120px] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.map((r) => (
            <TableRow
              key={rowKey(r)}
              className="cursor-pointer"
              onClick={() => router.push(`/triage/assessment/${encodeURIComponent(r.id)}`)}
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={sel.isSelected(r)}
                  onCheckedChange={() => sel.toggleSelection(r)}
                  aria-label="Select row"
                />
              </TableCell>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell>
                <KindBadge kind={r.kind} />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{r.effect}</TableCell>
              <TableCell>
                <ConfidenceBadge confidence={r.confidence} />
              </TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{formatCreatedAt(r.createdAt)}</TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                <div className="flex justify-end gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-emerald-600"
                    title="Approve"
                    onClick={() => approve(r)}
                    disabled={busy}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive"
                    title="Reject"
                    onClick={() => reject(r)}
                    disabled={busy}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-muted-foreground"
                    title="Delete"
                    onClick={() => dismiss(r)}
                    disabled={busy}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <DataPagination
        pageIndex={pageIndex}
        pageSize={pageSize}
        totalCount={sorted.length}
        onPageChange={setPageIndex}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPageIndex(0);
        }}
        itemLabel="proposals"
      />

      <BulkActionToolbar
        selectedCount={sel.selectedCount}
        entityType="proposal"
        onDelete={() => setShowBulkDelete(true)}
        onClearSelection={sel.clearSelection}
        isDeleting={busy}
      />
      <BulkDeleteDialog
        open={showBulkDelete}
        onOpenChange={setShowBulkDelete}
        count={sel.selectedCount}
        entityType="proposal"
        onConfirm={handleBulkDelete}
      />
    </>
  );
}

/** Resolved history — a full table (search/sort/pagination) like the inbox, but read-only. */
function ArchiveTable({ search }: { search: string }) {
  const router = useRouter();
  const { rows, isLoading, error } = useInboxArchive();
  const { sorted, toggle, icon } = useSorter(rows, search, 'name');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const pageRows = sorted.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (error) return <p className="p-4 text-sm text-destructive">Failed to load the archive.</p>;
  if (sorted.length === 0) {
    return (
      <Empty
        title={search ? 'No matches' : 'Nothing archived yet'}
        description={
          search ? 'No resolved proposals match your search.' : 'Approved, rejected, and dismissed proposals stay here.'
        }
      />
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="cursor-pointer select-none" onClick={() => toggle('name')}>
              Name {icon('name')}
            </TableHead>
            <TableHead className="w-[160px] cursor-pointer select-none" onClick={() => toggle('kind')}>
              Type {icon('kind')}
            </TableHead>
            <TableHead
              className="w-[130px] cursor-pointer select-none whitespace-nowrap"
              onClick={() => toggle('confidence')}
            >
              Confidence {icon('confidence')}
            </TableHead>
            <TableHead className="w-[180px]">Status</TableHead>
            <TableHead className="w-[130px]">Created</TableHead>
            <TableHead className="w-[110px] text-right">Output</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.map((r) => (
            <TableRow
              key={rowKey(r)}
              className="cursor-pointer"
              onClick={() => router.push(`/triage/assessment/${encodeURIComponent(r.id)}`)}
            >
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell>
                <KindBadge kind={r.kind} />
              </TableCell>
              <TableCell>
                <ConfidenceBadge confidence={r.confidence} />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <GenChip status={r.generationStatus} />
                </div>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{formatCreatedAt(r.createdAt)}</TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                {r.outputUrl ? (
                  <a
                    href={r.outputUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> View
                  </a>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <DataPagination
        pageIndex={pageIndex}
        pageSize={pageSize}
        totalCount={sorted.length}
        onPageChange={setPageIndex}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPageIndex(0);
        }}
        itemLabel="resolved"
      />
    </>
  );
}

function AssessmentArea() {
  const [tab, setTab] = useState<'inbox' | 'archive'>('inbox');
  const [search, setSearch] = useState('');

  return (
    <>
      {/* Header row — matches the platform tables (Reports/Library): title left, controls right. */}
      <div className="flex flex-col gap-4 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="shrink-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Assessments</h1>
          <p className="text-sm text-muted-foreground">
            Proactive proposals awaiting approval — discoveries, verdicts, and report recommendations.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="inline-flex items-center rounded-lg bg-muted p-1">
            {(['inbox', 'archive'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'rounded-md px-3 py-1 text-sm font-medium capitalize transition-colors',
                  tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search proposals…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full pl-10 sm:w-[200px]"
            />
          </div>
        </div>
      </div>

      <ErrorBoundary>
        {tab === 'inbox' ? <InboxTable search={search} /> : <ArchiveTable search={search} />}
      </ErrorBoundary>
    </>
  );
}

export default function AssessmentTriagePage() {
  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          <AssessmentArea />
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
