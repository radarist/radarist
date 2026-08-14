'use client';

/**
 * @file app/infographics/page.tsx
 * @description Infographics list page.
 *
 * Table layout matches the canonical library-table pattern
 * (reference: CompaniesTable + library/shared/SortableHeader):
 *
 *   - Plain-text sortable headers (Title / Style / Date) via the shared
 *     `SortableHeader`, with `aria-sort` on the `TableHead`
 *   - Shared `DataPagination` footer
 *   - Row hover with click-through to /infographics/[id]
 *   - Inline like/dislike (ThumbsUp / ThumbsDown) buttons per row,
 *     wired to `useLikeVisualization` for optimistic updates
 *   - Trailing `⋯` row menu (CONV-ROWMENU): Open (same handler as the
 *     row click) + Delete (`useDeleteVisualization`, confirmed via
 *     `AlertDialog`, mirrors the delete flow on the detail page)
 *
 * Sidebar entry was moved under Visualizations on 2026-05-13 — this
 * route URL stays at `/infographics` so existing links / bookmarks
 * keep working.
 */

import { Search, Image as ImageIcon, ThumbsUp, ThumbsDown, MoreHorizontal, Eye, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useMemo, useCallback } from 'react';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { EmptyState } from '@/components/feedback/EmptyState';
import { DataTableSkeleton } from '@/components/skeletons';
import {
  useVisualizations,
  useBulkDeleteVisualizations,
  useLikeVisualization,
  useDeleteVisualization,
} from '@/hooks/useVisualizations';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { BulkActionToolbar, BulkDeleteDialog } from '@/components/bulk-actions';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { cn } from '@/lib/utils';
import { formatEnumLabel } from '@/lib/enum-label';
import { safeFormatDate } from '@/lib/safe-format-date';
import type { SortDirection } from '@/components/library/shared/types';
import type { Visualization } from '@/lib/schemas/visualization';
import { VisualizationMedia } from '@/components/infographics/VisualizationMedia';

// CONV-DATE: record tables show absolute dates — never "Today" / "3d ago".
// Guarded — a malformed/missing timestamp must render '—', not throw.
function formatDate(dateStr: string): string {
  return safeFormatDate(dateStr, 'MMM d, yyyy');
}

const STYLE_COLORS: Record<string, string> = {
  professional: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  minimal: 'bg-muted text-muted-foreground',
  colorful: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  dark: 'bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200',
};

const SORT_KEYS = ['title', 'style', 'createdAt'] as const;
type SortKey = (typeof SORT_KEYS)[number];

function isSortKey(key: string): key is SortKey {
  return (SORT_KEYS as readonly string[]).includes(key);
}

const DEFAULT_PAGE_SIZE = 10;

export default function InfographicsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { data: visualizations, isLoading, error, refetch } = useVisualizations();
  const bulkDeleteMutation = useBulkDeleteVisualizations();
  const deleteMutation = useDeleteVisualization();
  const like = useLikeVisualization();

  const [searchQuery, setSearchQuery] = useState('');
  const [styleFilter, setStyleFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  // Sort + pagination are local state — the page doesn't deep-link to
  // shared URLs yet, so URL persistence isn't worth the surface area.
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'createdAt',
    direction: 'desc',
  });
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const filtered = useMemo(() => {
    if (!visualizations) return [];
    return visualizations.filter((v: Visualization) => {
      const matchesSearch =
        !searchQuery ||
        v.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        v.prompt.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStyle = styleFilter === 'all' || v.style === styleFilter;
      return matchesSearch && matchesStyle;
    });
  }, [visualizations, searchQuery, styleFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort]);

  const pageStart = pageIndex * pageSize;
  const paged = sorted.slice(pageStart, pageStart + pageSize);

  const handleSortClick = useCallback((key: string) => {
    if (!isSortKey(key)) return;
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'createdAt' ? 'desc' : 'asc' }
    );
    setPageIndex(0);
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setPageSize(size);
    setPageIndex(0);
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedIds(new Set(paged.map((v: Visualization) => v.id)));
      } else {
        setSelectedIds(new Set());
      }
    },
    [paged]
  );

  const isAllSelected = paged.length > 0 && paged.every((v) => selectedIds.has(v.id));
  const isSomeSelected = paged.some((v) => selectedIds.has(v.id)) && !isAllSelected;

  const handleLikeClick = useCallback(
    (viz: Visualization, target: 'up' | 'down') => {
      // Clicking the already-active button clears the rating. Otherwise
      // flip to the new value (true for up, false for down).
      const currentValue = viz.liked;
      const want = target === 'up' ? true : false;
      const next: boolean | null = currentValue === want ? null : want;
      like.mutate({ id: viz.id, liked: next });
    },
    [like]
  );

  const handleDeleteClick = useCallback(
    (viz: Visualization) => {
      deleteMutation.mutate(viz.id, {
        onSuccess: () => toast({ title: 'Visualization deleted' }),
      });
    },
    [deleteMutation, toast]
  );

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          <div
            data-testid="visualizations-page"
            className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between"
          >
            <div className="space-y-1 shrink-0">
              <h1 className="text-2xl font-semibold tracking-tight">Infographics</h1>
              <p className="text-sm text-muted-foreground">AI-generated infographics and visual representations</p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  data-testid="search-input"
                  placeholder="Search infographics..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              <Select value={styleFilter} onValueChange={setStyleFilter}>
                <SelectTrigger className="h-9 w-full sm:w-[160px]">
                  <SelectValue placeholder="All Styles" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Styles</SelectItem>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="minimal">Minimal</SelectItem>
                  <SelectItem value="colorful">Colorful</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <ErrorBoundary>
            {isLoading ? (
              <DataTableSkeleton rows={6} columns={6} />
            ) : error ? (
              // AUDIT-008: a failed fetch is not "no infographics" — surface it honestly.
              <EmptyState
                icon={ImageIcon}
                title="Could not load infographics"
                description={error instanceof Error ? error.message : 'Unknown error'}
                action={{ label: 'Retry', onClick: () => void refetch() }}
              />
            ) : sorted.length === 0 ? (
              searchQuery || styleFilter !== 'all' ? (
                <EmptyState
                  icon={ImageIcon}
                  title="No matching infographics"
                  description="Try adjusting your search or filters"
                  action={{
                    label: 'Clear filters',
                    onClick: () => {
                      setSearchQuery('');
                      setStyleFilter('all');
                    },
                  }}
                />
              ) : (
                <EmptyState
                  icon={ImageIcon}
                  title="No infographics yet"
                  description="Open the AI Assistant (Cmd+/) and ask it to create an infographic"
                  action={{
                    label: 'Open AI Assistant',
                    onClick: () => {
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }));
                    },
                  }}
                />
              )
            ) : (
              <div data-testid="visualizations-table" className="relative overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow className="hover:bg-transparent border-b border-border">
                      <TableHead className="w-[50px] px-4 py-3">
                        <Checkbox
                          checked={isAllSelected}
                          onCheckedChange={(checked) => toggleAll(!!checked)}
                          aria-label={isAllSelected ? 'Deselect all infographics' : 'Select all infographics'}
                          className={cn(isSomeSelected && 'opacity-50')}
                          data-testid="infographics-select-all"
                        />
                      </TableHead>
                      <TableHead className="w-[64px] px-4 py-3" />
                      <SortableHead
                        sortKey="title"
                        label="Title"
                        sort={sort}
                        onSortClick={handleSortClick}
                        className="max-w-0 w-full"
                      />
                      <SortableHead
                        sortKey="style"
                        label="Style"
                        sort={sort}
                        onSortClick={handleSortClick}
                        className="w-[130px]"
                      />
                      <SortableHead
                        sortKey="createdAt"
                        label="Date"
                        sort={sort}
                        onSortClick={handleSortClick}
                        className="w-[132px]"
                      />
                      <TableHead className="w-[152px] px-4 py-3 font-medium text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map((viz: Visualization) => (
                      <InfographicRow
                        key={viz.id}
                        viz={viz}
                        selected={selectedIds.has(viz.id)}
                        onSelectChange={() => toggleSelection(viz.id)}
                        onOpen={() => router.push(`/infographics/${viz.id}`)}
                        onLikeClick={handleLikeClick}
                        onDeleteClick={handleDeleteClick}
                      />
                    ))}
                  </TableBody>
                </Table>

                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={sorted.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={handlePageSizeChange}
                  itemLabel="infographics"
                />
              </div>
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>

      {/* Floating bulk action bar (shared with Reports). */}
      <BulkActionToolbar
        selectedCount={selectedIds.size}
        entityType="infographic"
        onDelete={() => setShowBulkDeleteDialog(true)}
        onClearSelection={() => setSelectedIds(new Set())}
      />

      <BulkDeleteDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
        count={selectedIds.size}
        entityType="infographic"
        onConfirm={async () => {
          await bulkDeleteMutation.mutateAsync(Array.from(selectedIds));
          setSelectedIds(new Set());
          setShowBulkDeleteDialog(false);
        }}
      />
    </SmartLayout>
  );
}

/**
 * `TableHead` wrapper around the shared library `SortableHeader` —
 * identical look to CompaniesTable headers, with `aria-sort` kept on
 * the `<th>` (its correct ARIA home) and a stable test id.
 */
function SortableHead({
  sortKey,
  label,
  sort,
  onSortClick,
  className,
}: {
  sortKey: SortKey;
  label: string;
  sort: { key: SortKey; direction: SortDirection };
  onSortClick: (key: string) => void;
  /** Column-width hint — Style/Date stay compact, Title stays flexible-but-bounded. */
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead
      className={cn('px-4 py-3', className)}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid={`infographics-sort-${sortKey}`}
    >
      <SortableHeader label={label} sortKey={sortKey} currentSort={sort} onSort={onSortClick} />
    </TableHead>
  );
}

function InfographicRow({
  viz,
  selected,
  onSelectChange,
  onOpen,
  onLikeClick,
  onDeleteClick,
}: {
  viz: Visualization;
  selected: boolean;
  onSelectChange: () => void;
  onOpen: () => void;
  onLikeClick: (viz: Visualization, target: 'up' | 'down') => void;
  onDeleteClick: (viz: Visualization) => void;
}) {
  const likedUp = viz.liked === true;
  const likedDown = viz.liked === false;

  return (
    <TableRow
      data-testid={`viz-row-${viz.id}`}
      className={cn(
        'group cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
        selected && 'bg-muted/50'
      )}
      onClick={onOpen}
    >
      <TableCell className="w-[50px] px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={onSelectChange}
          aria-label={`Select ${viz.title}`}
          data-testid={`viz-select-${viz.id}`}
        />
      </TableCell>

      <TableCell className="w-[64px] px-4 py-3">
        {viz.thumbnailUrl ? (
          <VisualizationMedia
            src={viz.thumbnailUrl}
            alt={viz.title}
            variant="thumbnail"
            fit={viz.mimeType === 'image/svg+xml' ? 'contain' : 'cover'}
            testId={`viz-thumb-${viz.id}`}
          />
        ) : (
          <VisualizationMedia src={null} alt={viz.title} variant="thumbnail" />
        )}
      </TableCell>

      <TableCell className="max-w-0 w-full px-4 py-3">
        <div className="flex flex-col max-w-[420px]">
          <span className="font-medium truncate group-hover:text-primary transition-colors">{viz.title}</span>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{viz.prompt}</p>
        </div>
      </TableCell>

      <TableCell className="w-[130px] px-4 py-3">
        <Badge variant="secondary" className={STYLE_COLORS[viz.style] ?? ''}>
          {formatEnumLabel(viz.style)}
        </Badge>
      </TableCell>

      <TableCell className="w-[132px] px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {formatDate(viz.createdAt)}
      </TableCell>

      <TableCell className="w-[152px] px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              likedUp
                ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 hover:text-emerald-600'
                : 'text-muted-foreground hover:bg-emerald-100 dark:hover:bg-emerald-950 hover:text-emerald-600'
            )}
            onClick={() => onLikeClick(viz, 'up')}
            aria-label={likedUp ? 'Remove like' : 'Like infographic'}
            aria-pressed={likedUp}
            data-testid={`viz-like-${viz.id}`}
          >
            <ThumbsUp className={cn('h-4 w-4', likedUp && 'fill-current')} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              likedDown
                ? 'bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive'
                : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
            )}
            onClick={() => onLikeClick(viz, 'down')}
            aria-label={likedDown ? 'Remove dislike' : 'Dislike infographic'}
            aria-pressed={likedDown}
            data-testid={`viz-dislike-${viz.id}`}
          >
            <ThumbsDown className={cn('h-4 w-4', likedDown && 'fill-current')} />
          </Button>

          <AlertDialog>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  data-testid={`viz-menu-${viz.id}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[140px]">
                <DropdownMenuItem onClick={onOpen} data-testid={`viz-menu-open-${viz.id}`}>
                  <Eye className="mr-2 h-4 w-4" />
                  Open
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <AlertDialogTrigger asChild>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    data-testid={`viz-menu-delete-${viz.id}`}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </AlertDialogTrigger>
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete infographic?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete &quot;{viz.title}&quot; and its image. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => onDeleteClick(viz)}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TableCell>
    </TableRow>
  );
}
