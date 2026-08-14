/**
 * @file app/triage/relations/page.tsx
 * @description Linker Triage Page - Review AI-proposed entity relations.
 * Canonical home of the Linker implementation — `/agents/linker` is a legacy
 * redirect stub that forwards here (P-F4, mirrors `/agents/signals`).
 *
 * Features:
 * - Triage view for one-at-a-time review
 * - List view for bulk actions
 * - Filtering by status, confidence, entity types
 * - Keyboard shortcuts (A/R/D/arrows)
 * - Bulk approve high-confidence proposals
 *
 * @author Radarist Team
 * @created 2026-01-20
 * @updated 2026-06-10 - Aligned with canonical library-table conventions
 *   (reference: CompaniesTable + library/shared/SortableHeader):
 *   sortable Source/Target/Relation/Confidence/Created columns via the
 *   shared SortableHeader (pure comparator in components/linker/proposal-sort),
 *   shared DataPagination footer, and the shared floating BulkActionToolbar
 *   (bottom of viewport) instead of a page-local top action bar.
 * @updated 2026-07-07 - Moved here from `/agents/linker` (P-F4); that route
 *   is now a redirect stub.
 * @updated 2026-07-27 - UX-037: one scope derivation. The page previously read
 *   TWO queries — the filtered `useProposedRelations()` for the visible list and
 *   the UNFILTERED `usePendingProposedRelations()` for `Approve High` — so the
 *   bulk approve wrote proposals the active filter had hidden. There is now a
 *   single `visibleProposals` array (components/linker/proposal-scope.ts) that
 *   feeds the list, the triage queue, the Approve-High count, the confirmation
 *   copy, and every bulk mutation. Selection is intersected with it on scope
 *   change and again at write time.
 */

'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Link2,
  List,
  Focus,
  Sparkles,
  Check,
  AlertTriangle,
  Search,
  X,
  Trash2,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { CONFIDENCE_EVIDENCE_GUIDE_URL } from '@/lib/public-documentation';
import {
  LinkerTriageQueue,
  LinkerProposalsTable,
  LinkerSkeleton,
  compareProposals,
  defaultProposalSortDirection,
  describeProposalScope,
  filterProposals,
  intersectSelection,
  isProposalSortField,
  selectHighConfidence,
  DEFAULT_PROPOSAL_SORT,
  type LinkerFiltersState,
} from '@/components/linker';
import { BulkActionToolbar } from '@/components/bulk-actions';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { EmptyState } from '@/components/feedback/EmptyState';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import {
  useProposedRelations,
  useBulkApproveProposedRelations,
  useBulkRejectProposedRelations,
  useBulkDeleteProposedRelations,
} from '@/hooks/useProposedRelations';
import { proposedRelationKeys } from '@/lib/query-keys';
import { useAuth } from '@/components/providers/AuthProvider';
import { createLogger } from '@/lib/logger';
import type { SortConfig } from '@/components/library/shared/types';

const log = createLogger('linker-page');

// Bulk-approve "high confidence" cutoff — single source so the filter and the
// confirmation copy can never drift (was: filter >=75 vs dialog text "≥85%").
const HIGH_CONFIDENCE_THRESHOLD = 75;

// ============================================================================
// VIEW MODE
// ============================================================================

type ViewMode = 'triage' | 'list';

const VIEW_MODE_STORAGE_KEY = 'radarist-linker-view-mode';

// ============================================================================
// DEFAULT FILTERS
// ============================================================================

const DEFAULT_FILTERS: LinkerFiltersState = {
  status: 'pending',
  sourceType: 'all',
  targetType: 'all',
  relationType: 'all',
  discoveredBy: 'all',
  minConfidence: 0,
  sortBy: 'createdAt-desc',
};

// ============================================================================
// PAGE COMPONENT
// ============================================================================

export default function LinkerTriagePage() {
  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('triage');
  const [filters, setFilters] = useState<LinkerFiltersState>(DEFAULT_FILTERS);
  const [bulkApproveDialogOpen, setBulkApproveDialogOpen] = useState(false);

  // Search, sort, and pagination state
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<SortConfig>(DEFAULT_PROPOSAL_SORT);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });

  // Selection state for bulk actions
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkActionDialog, setBulkActionDialog] = useState<'approve' | 'reject' | 'delete' | null>(null);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);

  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Load view mode from localStorage
  useEffect(() => {
    const savedMode = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (savedMode === 'list' || savedMode === 'triage') {
      setViewMode(savedMode);
    }
  }, []);

  // Toggle view mode and save to localStorage
  const toggleViewMode = useCallback(() => {
    const newMode: ViewMode = viewMode === 'list' ? 'triage' : 'list';
    setViewMode(newMode);
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, newMode);
  }, [viewMode]);

  // ONE query, ONE scope. The page used to hold a second, unfiltered
  // `usePendingProposedRelations()` alongside this one and derive Approve High
  // from it — that divergence is UX-037 and is why the second query is gone.
  const { data: allProposals = [], isLoading, error } = useProposedRelations();

  const bulkApproveMutation = useBulkApproveProposedRelations();
  const bulkRejectMutation = useBulkRejectProposedRelations();
  const bulkDeleteMutation = useBulkDeleteProposedRelations();

  /**
   * The visible scope: every proposal the active search + facets admit, in the
   * operator's chosen order. Pagination slices this; it does not narrow it.
   * Everything the page can WRITE is derived from this array.
   */
  const visibleProposals = useMemo(() => {
    const scoped = filterProposals(allProposals, { searchQuery, filters });
    // compareProposals is stable, so equal keys keep query order.
    return scoped.sort((a, b) => compareProposals(a, b, sort));
  }, [allProposals, filters, searchQuery, sort]);

  // Toggle column sort — same column flips direction; a new column starts
  // desc for numeric/date (Confidence/Created) and asc for text columns.
  const handleSortClick = useCallback((key: string) => {
    if (!isProposalSortField(key)) return;
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: defaultProposalSortDirection(key) }
    );
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, []);

  // Paginated proposals for list view
  const paginatedProposals = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize;
    return visibleProposals.slice(start, start + pagination.pageSize);
  }, [visibleProposals, pagination]);

  /**
   * The triage queue reviews what still needs a decision, so it takes the
   * pending members of the SAME scope the header facets describe — not a
   * separate unfiltered query, which is what made the filter bar decorative in
   * triage mode.
   */
  const triageProposals = useMemo(() => visibleProposals.filter((p) => p.status === 'pending'), [visibleProposals]);

  // Reset pagination when filters or search changes
  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, [filters, searchQuery]);

  // High confidence pending proposals (for bulk approve). Derived from the
  // VISIBLE scope — a proposal the operator cannot see is not in this set, so
  // it can be neither counted nor approved.
  // Task 3.8: threshold lowered from 85 to 75 to match auto-approve.
  const highConfidencePending = useMemo(
    () => selectHighConfidence(visibleProposals, HIGH_CONFIDENCE_THRESHOLD),
    [visibleProposals]
  );

  /** Human-readable rendering of the active scope, for the confirmation copy. */
  const scopeDescription = useMemo(() => describeProposalScope(searchQuery, filters), [searchQuery, filters]);

  /**
   * Selection outlives a scope change. Prune it so the toolbar count, the
   * confirmation copy, and the write set stay equal to what is on screen.
   * `intersectSelection` returns the same reference when nothing was dropped,
   * so this cannot loop.
   */
  useEffect(() => {
    setSelectedIds((prev) => intersectSelection(prev, visibleProposals));
  }, [visibleProposals]);

  // Handle proposal processed in triage mode
  const handleProposalProcessed = useCallback((proposalId: string, action: 'approved' | 'rejected' | 'dismissed') => {
    // Optimistic update is handled by the mutation
    log.info(`Proposal ${proposalId} ${action}`);
  }, []);

  // Handle bulk approve (high confidence). The id set comes from the visible
  // scope, so this cannot reach a proposal the active filter hides. A failure
  // leaves the dialog open: the operator retries the same, still-correct set.
  const handleBulkApprove = useCallback(async () => {
    const ids = highConfidencePending.map((p) => p.id);
    if (ids.length === 0) return;

    try {
      await bulkApproveMutation.mutateAsync({
        proposalIds: ids,
        reviewedBy: user?.uid ?? 'anonymous',
      });
      setBulkApproveDialogOpen(false);
    } catch (err) {
      // The mutation's onError surfaces the toast; keeping the dialog open is
      // what makes the action retryable instead of silently lost.
      log.error('Bulk approve failed', err instanceof Error ? err : new Error(String(err)));
    }
  }, [highConfidencePending, bulkApproveMutation, user?.uid]);

  // Handle bulk action (approve/reject/delete for selected items)
  const processBulkAction = useCallback(
    async (action: 'approve' | 'reject' | 'delete') => {
      // Re-intersect at write time. The selection effect already pruned on the
      // last render, but a refetch landing between click and dispatch must not
      // be able to widen the write beyond what is on screen.
      const authorizedIds = intersectSelection(selectedIds, visibleProposals);
      if (authorizedIds.length < selectedIds.length) {
        log.warn('Dropped selected proposals that left the visible scope', {
          selected: selectedIds.length,
          authorized: authorizedIds.length,
        });
      }
      if (authorizedIds.length === 0) {
        setSelectedIds([]);
        setBulkActionDialog(null);
        return;
      }

      setIsBulkProcessing(true);
      setBulkActionDialog(null);

      try {
        let result: { failedIds?: string[] } | undefined;
        if (action === 'approve') {
          result = await bulkApproveMutation.mutateAsync({
            proposalIds: authorizedIds,
            reviewedBy: user?.uid ?? 'anonymous',
          });
        } else if (action === 'reject') {
          result = await bulkRejectMutation.mutateAsync({
            proposalIds: authorizedIds,
            reviewedBy: user?.uid ?? 'anonymous',
          });
        } else {
          result = await bulkDeleteMutation.mutateAsync({ proposalIds: authorizedIds });
        }
        // Keep exactly the proposals that did NOT settle selected, so a partial
        // failure stays retryable instead of vanishing from the toolbar. A
        // resolved mutation that reports nothing means everything settled.
        setSelectedIds(result?.failedIds ?? []);
      } catch (err) {
        // Whole-dispatch failure: nothing settled, so the selection stands.
        log.error(`Bulk ${action} failed`, err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsBulkProcessing(false);
      }
    },
    [selectedIds, visibleProposals, bulkApproveMutation, bulkRejectMutation, bulkDeleteMutation, user?.uid]
  );

  // Refresh data
  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: proposedRelationKeys.all });
  }, [queryClient]);

  // Loading state
  if (isLoading) {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent noPadding>
            <div className="p-4">
              <LinkerSkeleton />
            </div>
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  // Error state
  if (error) {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent noPadding>
            <div className="p-4">
              <EmptyState
                icon={AlertTriangle}
                title="Error Loading Proposals"
                description="Unable to load proposed relations. Please try again."
                action={{
                  label: 'Retry',
                  onClick: handleRefresh,
                }}
              />
            </div>
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1 shrink-0">
              <h1 className="text-2xl font-semibold tracking-tight">Linker</h1>
              <p className="text-sm text-muted-foreground">Review AI-proposed entity relations.</p>
              <a
                href={CONFIDENCE_EVIDENCE_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                How confidence and evidence work
                <span className="sr-only"> (opens in a new tab)</span>
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {/* Search Input */}
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search entities..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 w-full pl-9 sm:w-[180px]"
                />
              </div>

              {/* Status Filter */}
              <Select
                value={filters.status}
                onValueChange={(value) =>
                  setFilters((prev) => ({
                    ...prev,
                    status: value as LinkerFiltersState['status'],
                  }))
                }
              >
                <SelectTrigger className="h-9 w-full sm:w-[130px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="dismissed">Dismissed</SelectItem>
                </SelectContent>
              </Select>

              {/* Source Filter */}
              <Select
                value={filters.discoveredBy}
                onValueChange={(value) =>
                  setFilters((prev) => ({
                    ...prev,
                    discoveredBy: value as LinkerFiltersState['discoveredBy'],
                  }))
                }
              >
                <SelectTrigger className="h-9 w-full sm:w-[130px]">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="linker-agent">Linker Agent</SelectItem>
                  <SelectItem value="auto-linker">Auto-Linker</SelectItem>
                  <SelectItem value="ai-assistant">AI Assistant</SelectItem>
                </SelectContent>
              </Select>

              {/* Bulk Approve Button */}
              {highConfidencePending.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 h-9"
                  onClick={() => setBulkApproveDialogOpen(true)}
                >
                  <Sparkles className="h-4 w-4" />
                  Approve High ({highConfidencePending.length})
                </Button>
              )}

              {/* View Mode Toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9"
                    onClick={toggleViewMode}
                    aria-label={viewMode === 'list' ? 'Switch to triage view' : 'Switch to list view'}
                  >
                    {viewMode === 'list' ? <Focus className="h-4 w-4" /> : <List className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{viewMode === 'list' ? 'Switch to triage view' : 'Switch to list view'}</TooltipContent>
              </Tooltip>

              {/* Show Processed Toggle — a shortcut onto the status facet, not a
                  second piece of state. It previously held its own `showProcessed`
                  boolean that nothing ever read, so the control did nothing. */}
              <div className="flex items-center gap-2">
                <Switch
                  id="show-processed"
                  checked={filters.status === 'all'}
                  onCheckedChange={(checked) =>
                    setFilters((prev) => ({ ...prev, status: checked ? 'all' : 'pending' }))
                  }
                  aria-label="Show processed relations"
                />
                <Label htmlFor="show-processed" className="text-sm text-muted-foreground whitespace-nowrap">
                  Show processed
                </Label>
              </div>
            </div>
          </div>

          {/* Content */}
          {viewMode === 'triage' ? (
            // Triage View
            <div className="p-4">
              <LinkerTriageQueue
                proposals={triageProposals}
                onProposalProcessed={handleProposalProcessed}
                userId={user?.uid ?? 'anonymous'}
              />
              {triageProposals.length === 0 && allProposals.length > 0 && (
                <div className="text-center py-8">
                  <p className="text-muted-foreground mb-2">
                    No pending proposals to triage in {scopeDescription} (showing {allProposals.length} total).
                  </p>
                  <Button variant="outline" onClick={toggleViewMode}>
                    <List className="h-4 w-4 mr-2" />
                    Switch to List View
                  </Button>
                </div>
              )}
            </div>
          ) : (
            // List View
            <div>
              {visibleProposals.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    icon={Link2}
                    title={searchQuery ? 'No matching proposals' : 'No proposed relations'}
                    description={
                      searchQuery
                        ? 'Try adjusting your search or filters.'
                        : 'The Linker Agent will discover and propose new relations automatically.'
                    }
                    action={
                      searchQuery
                        ? {
                            label: 'Clear Search',
                            onClick: () => setSearchQuery(''),
                          }
                        : {
                            label: 'Switch to Triage View',
                            onClick: toggleViewMode,
                          }
                    }
                  />
                </div>
              ) : (
                <>
                  {/* Flush table — no wrapper padding, so the header row sits
                      directly under the toolbar border like the library tables
                      (a p-4 here read as a "taller header" band). */}
                  <LinkerProposalsTable
                    proposals={paginatedProposals}
                    selectedIds={selectedIds}
                    onSelectionChange={setSelectedIds}
                    userId={user?.uid ?? 'anonymous'}
                    sort={sort}
                    onSortClick={handleSortClick}
                  />
                  <DataPagination
                    pageIndex={pagination.pageIndex}
                    pageSize={pagination.pageSize}
                    totalCount={visibleProposals.length}
                    onPageChange={(pageIndex) => setPagination((prev) => ({ ...prev, pageIndex }))}
                    onPageSizeChange={(pageSize) => setPagination((prev) => ({ ...prev, pageSize }))}
                    itemLabel="proposals"
                  />
                </>
              )}
            </div>
          )}
        </PageContent>
      </PageShell>

      {/* Bulk Action Toolbar — shared floating bottom toolbar (same surface as
          companies/infographics/signals). Approve/Reject/Delete open the same
          confirmation dialog the old top bar used; the built-in X clears
          the selection. */}
      <BulkActionToolbar
        selectedCount={selectedIds.length}
        entityType="proposal"
        onClearSelection={() => setSelectedIds([])}
        additionalActions={
          <>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={() => setBulkActionDialog('approve')}
              disabled={isBulkProcessing}
              data-testid="bulk-approve"
            >
              {isBulkProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
              Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setBulkActionDialog('reject')}
              disabled={isBulkProcessing}
              data-testid="bulk-reject"
            >
              {isBulkProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4 mr-1" />}
              Reject
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => setBulkActionDialog('delete')}
              disabled={isBulkProcessing}
              data-testid="bulk-delete"
            >
              {isBulkProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Delete
            </Button>
          </>
        }
      />

      {/* Bulk Approve Dialog (High Confidence) */}
      <AlertDialog open={bulkApproveDialogOpen} onOpenChange={setBulkApproveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {highConfidencePending.length} High-Confidence Proposals?</AlertDialogTitle>
            <AlertDialogDescription>
              This will approve {highConfidencePending.length} pending{' '}
              {highConfidencePending.length === 1 ? 'proposal' : 'proposals'} with confidence ≥
              {HIGH_CONFIDENCE_THRESHOLD}% and create the corresponding relations. It covers only the proposals in the
              current view — {scopeDescription} — across every page of that result, and nothing outside it. This action
              cannot be undone in bulk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkApprove}
              disabled={bulkApproveMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              <Check className="h-4 w-4 mr-2" />
              {bulkApproveMutation.isPending ? 'Approving...' : `Approve ${highConfidencePending.length}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Action Confirmation Dialog */}
      <AlertDialog open={bulkActionDialog !== null} onOpenChange={() => setBulkActionDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkActionDialog === 'approve' &&
                `Approve ${selectedIds.length} Proposal${selectedIds.length !== 1 ? 's' : ''}?`}
              {bulkActionDialog === 'reject' &&
                `Reject ${selectedIds.length} Proposal${selectedIds.length !== 1 ? 's' : ''}?`}
              {bulkActionDialog === 'delete' &&
                `Delete ${selectedIds.length} Proposal${selectedIds.length !== 1 ? 's' : ''}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkActionDialog === 'approve' &&
                `This will approve ${selectedIds.length} proposal${selectedIds.length !== 1 ? 's' : ''} and create the corresponding relations.`}
              {bulkActionDialog === 'reject' &&
                `This will reject ${selectedIds.length} proposal${selectedIds.length !== 1 ? 's' : ''}.`}
              {bulkActionDialog === 'delete' &&
                `This will permanently delete ${selectedIds.length} proposal${selectedIds.length !== 1 ? 's' : ''}. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bulkActionDialog && processBulkAction(bulkActionDialog)}
              className={
                bulkActionDialog === 'approve'
                  ? 'bg-emerald-600 hover:bg-emerald-700'
                  : bulkActionDialog === 'reject' || bulkActionDialog === 'delete'
                    ? 'bg-destructive hover:bg-destructive/90'
                    : ''
              }
            >
              {bulkActionDialog === 'approve' && 'Approve All'}
              {bulkActionDialog === 'reject' && 'Reject All'}
              {bulkActionDialog === 'delete' && 'Delete All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SmartLayout>
  );
}
