/**
 * @file page.tsx (Agents > Signals)
 * @description Signals page matching Library table design pattern
 *
 * Features:
 * - Table view with sortable columns
 * - Filters in header row (like Companies page)
 * - Status badges, source badges, trust scores
 * - Bulk selection and actions
 * - Pagination with rows-per-page selector
 * - Toggle between List and Triage views
 *
 * @author Radarist Team
 * @created 2025-11-25
 * @updated 2025-11-30 - Redesigned to match Library table pattern
 * @updated 2025-12-03 - Added List/Triage view toggle (H5)
 * @updated 2026-06-10 - Aligned with canonical library-table conventions
 *   (reference: CompaniesTable + library/shared/SortableHeader):
 *   shared plain-text SortableHeader (aria-sort kept on the th), shared
 *   DataPagination footer, and the shared floating BulkActionToolbar
 *   (bottom of viewport) instead of a page-local top action bar.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import Link from 'next/link';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Search as SearchIcon,
  Check,
  X,
  Loader2,
  Radio,
  Bot,
  MoreHorizontal,
  Eye,
  ExternalLink,
  List,
  Focus,
  Copy,
  Layers,
  ChevronDown,
  ChevronUp,
  Archive,
  ArchiveRestore,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { CONFIDENCE_EVIDENCE_GUIDE_URL } from '@/lib/public-documentation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
} from '@/components/ui/alert-dialog';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BulkActionToolbar } from '@/components/bulk-actions';
import { DataPagination } from '@/components/library/shared/DataPagination';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { TrustScoreBadge } from '@/components/signals/TrustScoreBadge';
import { EmptyState as FeedbackEmptyState } from '@/components/feedback/EmptyState';
import { SignalTriageQueue } from '@/components/signals/SignalTriageQueue';
import { Skeleton } from '@/components/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Signal } from '@/lib/types';
import { getSignals } from '@/lib/signals-client';
import { submitSignalFeedback } from '@/lib/signals/feedback';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { parseBulkDeleteAcknowledgement } from '@/lib/bulk-delete-acknowledgement';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('signals-page');

// ============================================================================
// TYPES
// ============================================================================

interface PaginationState {
  pageIndex: number;
  pageSize: number;
}

const SORT_FIELDS = ['date', 'title', 'status', 'source', 'trust'] as const;
type SortField = (typeof SORT_FIELDS)[number];

/**
 * How long a quick approve/reject stays undoable before its server write is
 * committed (F71). Kept in sync with the undo toast's visible lifetime.
 */
export const QUICK_FEEDBACK_UNDO_WINDOW_MS = 5000;

function isSortField(key: string): key is SortField {
  return (SORT_FIELDS as readonly string[]).includes(key);
}

type SortDirection = 'asc' | 'desc';
type ViewMode = 'list' | 'triage';
type GroupByOption = 'none' | 'agent' | 'source' | 'date';

const VIEW_MODE_STORAGE_KEY = 'radarist-signals-view-mode';
const GROUP_BY_STORAGE_KEY = 'radarist-signals-group-by';

// ============================================================================
// STATUS BADGE COMPONENT
// ============================================================================

/**
 * The thumbs-up/down "kept" state derives from the signal's STATUS, not only from an
 * explicit UI feedback vote — so a signal approved via the detail page, the chat, or
 * auto-approve still shows its thumbs-up filled. Falls back to feedback.vote for any
 * legacy/edge case where status isn't Approved/Rejected.
 */
function displayedVote(signal: Signal): 'up' | 'down' | undefined {
  if (signal.status === 'Approved') return 'up';
  if (signal.status === 'Rejected') return 'down';
  return signal.feedback?.vote;
}

function SignalStatusBadge({ status }: { status: string }) {
  const config: Record<string, { className: string }> = {
    Detected: { className: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30' },
    Validated: { className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30' },
    Approved: { className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' },
    Rejected: { className: 'bg-destructive/10 text-destructive border-destructive/30' },
    Imported: { className: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30' },
    Archived: { className: 'bg-muted text-muted-foreground border-border' },
  };

  const { className } = config[status] || { className: 'bg-muted text-muted-foreground' };

  return (
    <Badge variant="outline" className={cn('text-xs font-normal', className)}>
      {status}
    </Badge>
  );
}

// ============================================================================
// EMPTY STATE COMPONENT
// ============================================================================

function EmptyState({ hasFilters, onClearFilters }: { hasFilters: boolean; onClearFilters: () => void }) {
  return (
    <div className="text-center py-16 px-4">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-4">
        <Radio className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold mb-2">{hasFilters ? 'No signals found' : 'No signals yet'}</h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-sm mx-auto">
        {hasFilters
          ? 'Try adjusting your search or filters.'
          : 'Signals will appear here once detected by your agents.'}
      </p>
      {hasFilters ? (
        <Button variant="outline" onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : (
        <Button asChild>
          <Link href="/agents">
            <Bot className="h-4 w-4 mr-2" />
            Go to Agents
          </Link>
        </Button>
      )}
    </div>
  );
}

// ============================================================================
// SORTABLE HEADER
// ============================================================================

/**
 * `TableHead` wrapper around the shared library `SortableHeader` —
 * identical look to CompaniesTable headers, with `aria-sort` kept on
 * the `<th>` (its correct ARIA home) and a stable test id.
 */
function SortableHead({
  label,
  field,
  currentField,
  currentDirection,
  onSort,
}: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDirection: SortDirection;
  onSort: (field: SortField) => void;
}) {
  const isActive = currentField === field;

  return (
    <TableHead
      className="px-4 py-3"
      aria-sort={isActive ? (currentDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid={`signals-sort-${field}`}
    >
      <SortableHeader
        label={label}
        sortKey={field}
        currentSort={{ key: currentField, direction: currentDirection }}
        onSort={(key) => {
          if (isSortField(key)) onSort(key);
        }}
      />
    </TableHead>
  );
}

// ============================================================================
// MAIN PAGE COMPONENT
// ============================================================================

export default function SignalsPage() {
  const { user } = useAuth();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [filteredSignals, setFilteredSignals] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // AUDIT-008: a failed load must render a persistent error body, not just a
  // transient toast that leaves an all-clear "No signals yet" behind.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');

  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [showArchived, setShowArchived] = useState(false);

  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [selectedSignalIds, setSelectedSignalIds] = useState<Set<string>>(new Set());
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkActionDialog, setBulkActionDialog] = useState<'approve' | 'reject' | 'delete' | 'archive' | null>(null);

  // View mode state (List vs Triage)
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // Group by state
  const [groupBy, setGroupBy] = useState<GroupByOption>('none');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const { toast } = useToast();

  // Load view mode preference from localStorage on mount
  useEffect(() => {
    const savedMode = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (savedMode === 'list' || savedMode === 'triage') {
      setViewMode(savedMode);
    }

    // Load groupBy preference
    const savedGroupBy = localStorage.getItem(GROUP_BY_STORAGE_KEY);
    if (savedGroupBy === 'none' || savedGroupBy === 'agent' || savedGroupBy === 'source' || savedGroupBy === 'date') {
      setGroupBy(savedGroupBy);
    }
  }, []);

  // Toggle view mode and save to localStorage
  const toggleViewMode = useCallback(() => {
    const newMode: ViewMode = viewMode === 'list' ? 'triage' : 'list';
    setViewMode(newMode);
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, newMode);
  }, [viewMode]);

  // Handle groupBy change and save to localStorage
  const handleGroupByChange = useCallback((value: GroupByOption) => {
    setGroupBy(value);
    localStorage.setItem(GROUP_BY_STORAGE_KEY, value);
    // Expand all groups by default when switching to a new grouping
    setExpandedGroups(new Set());
  }, []);

  // Toggle group expansion
  const toggleGroupExpansion = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(groupKey)) {
        newSet.delete(groupKey);
      } else {
        newSet.add(groupKey);
      }
      return newSet;
    });
  }, []);

  const hasFilters = searchQuery.trim() !== '' || statusFilter !== 'all' || sourceFilter !== 'all' || showArchived;

  const paginatedSignals = useMemo(() => {
    const start = pagination.pageIndex * pagination.pageSize;
    const end = start + pagination.pageSize;
    return filteredSignals.slice(start, end);
  }, [filteredSignals, pagination.pageIndex, pagination.pageSize]);

  // Compute grouped signals
  interface SignalGroup {
    key: string;
    label: string;
    signals: Signal[];
  }

  const groupedSignals = useMemo((): SignalGroup[] => {
    if (groupBy === 'none') return [];

    const groups = new Map<string, Signal[]>();

    paginatedSignals.forEach((signal) => {
      let groupKey: string;

      switch (groupBy) {
        case 'agent':
          groupKey = signal.metadata?.agentName || signal.metadata?.agentId || 'Unknown Agent';
          break;
        case 'source':
          groupKey = signal.source || 'Unknown Source';
          break;
        case 'date':
          // Group by date (YYYY-MM-DD)
          groupKey = new Date(signal.detectedAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          });
          break;
        default:
          groupKey = 'Unknown';
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(signal);
    });

    // Convert to array and sort groups
    const groupArray: SignalGroup[] = Array.from(groups.entries()).map(([key, signals]) => ({
      key,
      label: key,
      signals,
    }));

    // Sort groups: by date (newest first) for date grouping, alphabetically for others
    if (groupBy === 'date') {
      groupArray.sort((a, b) => {
        // Compare by first signal date in each group (descending)
        const dateA = a.signals[0]?.detectedAt || 0;
        const dateB = b.signals[0]?.detectedAt || 0;
        return dateB - dateA;
      });
    } else {
      groupArray.sort((a, b) => a.label.localeCompare(b.label));
    }

    return groupArray;
  }, [paginatedSignals, groupBy]);

  // Check if a group is expanded (default: all expanded)
  const isGroupExpanded = useCallback(
    (groupKey: string) => {
      // By default, all groups are expanded (expandedGroups tracks collapsed ones)
      return !expandedGroups.has(groupKey);
    },
    [expandedGroups]
  );

  const selectedCount = selectedSignalIds.size;
  const isAllSelected = paginatedSignals.length > 0 && paginatedSignals.every((s) => selectedSignalIds.has(s.id));
  const isSomeSelected = !isAllSelected && paginatedSignals.some((s) => selectedSignalIds.has(s.id));

  const clearFilters = () => {
    setSearchQuery('');
    setStatusFilter('all');
    setSourceFilter('all');
    setShowArchived(false);
  };

  const loadSignals = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const signalsData = await getSignals();
      setSignals(signalsData);
    } catch (error) {
      log.error('Failed to load signals', error instanceof Error ? error : new Error(String(error)));
      setLoadError(error instanceof Error ? error.message : 'Failed to load signals.');
      toast({ title: 'Error', description: 'Failed to load signals.', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  // Listen for data refresh events from AI Assistant
  useDataRefresh(['signals'], () => {
    log.info('Auto-refreshing data after AI Assistant action');
    loadSignals();
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const toggleSignalSelection = useCallback((signalId: string) => {
    setSelectedSignalIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(signalId)) {
        newSet.delete(signalId);
      } else {
        newSet.add(signalId);
      }
      return newSet;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (isAllSelected) {
      setSelectedSignalIds((prev) => {
        const newSet = new Set(prev);
        paginatedSignals.forEach((s) => newSet.delete(s.id));
        return newSet;
      });
    } else {
      setSelectedSignalIds((prev) => {
        const newSet = new Set(prev);
        paginatedSignals.forEach((s) => newSet.add(s.id));
        return newSet;
      });
    }
  }, [isAllSelected, paginatedSignals]);

  const processBulkAction = useCallback(
    async (action: 'approve' | 'reject' | 'delete' | 'archive') => {
      if (selectedSignalIds.size === 0) return;
      setIsBulkProcessing(true);
      setBulkActionDialog(null);

      const selectedIds = Array.from(selectedSignalIds);
      let successCount = 0;
      let retainedDeleteIds: string[] = [];

      if (action === 'archive') {
        // Bulk archive via the admin-SDK route (same server path as delete).
        try {
          const response = await fetchWithAuth('/api/signals/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: selectedIds, action: 'archive' }),
          });
          const data = await response.json();
          if (response.ok) {
            successCount = data.changed;
          }
        } catch (e) {
          log.error('Bulk archive failed', e instanceof Error ? e : new Error(String(e)));
        }

        toast({
          title: 'Bulk Archive Complete',
          description: `Archived ${successCount} of ${selectedIds.length} signals.`,
        });
      } else if (action === 'delete') {
        // Call bulk delete API
        try {
          const response = await fetchWithAuth('/api/signals/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: selectedIds }),
          });
          const body = await response.json();
          if (!response.ok) {
            const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
            throw new Error(typeof error === 'string' ? error : 'Failed to delete signals');
          }
          const data = parseBulkDeleteAcknowledgement(body, selectedIds);
          successCount = data.deleted;
          retainedDeleteIds = data.failed;

          toast({
            title: retainedDeleteIds.length > 0 ? 'Signals Partially Deleted' : 'Bulk Delete Complete',
            description: `Deleted ${successCount} of ${selectedIds.length} signals.${
              retainedDeleteIds.length > 0 ? ` ${retainedDeleteIds.length} retained for retry.` : ''
            }`,
            ...(retainedDeleteIds.length > 0 ? { variant: 'destructive' as const } : {}),
          });
        } catch (e) {
          log.error('Bulk delete failed', e instanceof Error ? e : new Error(String(e)));
          retainedDeleteIds = selectedIds;
          toast({
            title: 'Bulk Delete Failed',
            description: 'No confirmed deletions were removed from the selection. Retry when the service is available.',
            variant: 'destructive',
          });
        }
      } else {
        for (const signalId of selectedIds) {
          try {
            const result = await submitSignalFeedback(
              signalId,
              action === 'approve' ? 'up' : 'down',
              undefined,
              true,
              user?.uid || 'anonymous',
              true
            );
            if (result.success) successCount++;
          } catch {
            // continue
          }
        }

        toast({
          title: `Bulk ${action === 'approve' ? 'Approval' : 'Rejection'} Complete`,
          description: `${action === 'approve' ? 'Approved' : 'Rejected'} ${successCount} of ${selectedIds.length} signals.`,
        });
      }

      setSelectedSignalIds(action === 'delete' ? new Set(retainedDeleteIds) : new Set());
      setIsBulkProcessing(false);
      loadSignals();
    },
    [selectedSignalIds, toast]
  );

  const handleQuickFeedback = async (signalId: string, isPositive: boolean) => {
    // Find the signal to get its original state for potential undo
    const signal = signals.find((s) => s.id === signalId);
    if (!signal) return;

    const originalFeedback = signal.feedback;
    const newFeedback: Signal['feedback'] = {
      vote: isPositive ? 'up' : 'down',
      votedAt: Date.now(),
      votedBy: user?.uid ?? 'anonymous',
      includedInFeedbackLoop: true,
    };

    // Optimistically update the signal in local state (instant feedback)
    setSignals((prev) => prev.map((s) => (s.id === signalId ? { ...s, feedback: newFeedback } : s)));

    // F71: DEFER the server write until the undo window elapses. Previously the
    // write fired immediately, so clicking Undo reverted only local state while
    // the server had already recorded the feedback — "Undone" was a lie. Now the
    // write happens only if the window closes without an Undo; Undo cancels it,
    // so an undone action is never submitted.
    let undone = false;
    // Assigned from the undo toast below — it cannot be declared there, because the
    // toast's own Undo handler needs `commitTimer`, which needs `commit`, which
    // reads this. `commit` runs a full undo window later, so the binding is always
    // populated by the time it is read.
    let dismissUndoToast: (() => void) | undefined = undefined;
    const commit = async () => {
      if (undone) return;
      // UX-074: the undo window is over — retire the Undo affordance BEFORE the
      // write, so the toast can never offer to reverse an action already
      // submitted. Radix pauses a toast's own dismiss timer while the pointer is
      // over it (which is exactly what you do to reach Undo), so the button can
      // outlive QUICK_FEEDBACK_UNDO_WINDOW_MS. Without this, the status patch
      // below would leave a row reading "Approved" next to an "Undone" toast.
      dismissUndoToast?.();
      try {
        const result = await submitSignalFeedback(
          signalId,
          isPositive ? 'up' : 'down',
          undefined,
          true,
          user?.uid ?? 'anonymous',
          true
        );
        // AUDIT-005: submitSignalFeedback swallows its own errors and reports
        // {success:false} — treat that as a failed write, not a success.
        if (!result.success) {
          throw new Error(result.error || 'Failed to submit feedback');
        }
        // UX-074: the row's STATUS is patched HERE — on a confirmed server write —
        // and deliberately NOT at click time. The write is DEFERRED behind the undo
        // window (F71 above), so a click-time status patch would claim a state the
        // server has not reached and would then have to be walked back on Undo or
        // on failure. The operator already has immediate confirmation at t=0: the
        // optimistic `feedback` patch flips the action column to the frozen
        // indicator, which is also what makes a re-click impossible.
        //
        // What lands here is purely the SERVER's outcome — the same fields
        // submitSignalFeedback writes with updateStatus=true (src/lib/signals/
        // feedback.ts). Without it the status badge, the result count, and
        // status-filter membership all stayed stale until a full reload, because
        // every one of them reads `signal.status`.
        //
        // Only `status` drives the UI here; `reviewedAt`/`reviewedBy` are patched
        // so the local row matches what the server just wrote rather than carrying
        // stale review provenance. The next loadSignals() replaces all three with
        // the authoritative values.
        if (undone) return; // Undo raced the in-flight write — honour "Undone".
        setSignals((prev) =>
          prev.map((s) =>
            s.id === signalId
              ? {
                  ...s,
                  status: isPositive ? 'Approved' : 'Rejected',
                  reviewedAt: Date.now(),
                  reviewedBy: user?.uid ?? 'anonymous',
                }
              : s
          )
        );
      } catch (e) {
        log.error('Quick feedback failed', e instanceof Error ? e : new Error(String(e)), { signalId });
        setSignals((prev) => prev.map((s) => (s.id === signalId ? { ...s, feedback: originalFeedback } : s)));
        toast({ title: 'Error', description: 'Failed to submit feedback. Action reverted.', variant: 'destructive' });
      }
    };
    const commitTimer = setTimeout(commit, QUICK_FEEDBACK_UNDO_WINDOW_MS);

    const { dismiss } = toast({
      title: isPositive ? 'Signal Approved' : 'Signal Rejected',
      description: 'Quick action completed.',
      action: (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // Cancel the pending server write and revert the optimistic update —
            // nothing was ever submitted.
            undone = true;
            clearTimeout(commitTimer);
            setSignals((prev) => prev.map((s) => (s.id === signalId ? { ...s, feedback: originalFeedback } : s)));
            dismiss();
            toast({ title: 'Undone', description: 'Action has been reversed.' });
          }}
        >
          Undo
        </Button>
      ),
    });
    dismissUndoToast = dismiss;
  };

  // Archive or restore a single signal from the row menu. Goes through the
  // admin-SDK /api/signals/archive route (same server path as bulk delete) — NOT
  // the deprecated client-SDK signals-approval module.
  const handleArchiveToggle = useCallback(
    async (signalId: string, action: 'archive' | 'restore') => {
      try {
        const response = await fetchWithAuth('/api/signals/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [signalId], action }),
        });
        const data = await response.json();
        if (!response.ok || data.changed !== 1) {
          throw new Error(data.error || `Failed to ${action} signal`);
        }
        toast({
          title: action === 'archive' ? 'Signal Archived' : 'Signal Restored',
          description: action === 'archive' ? 'Moved to the archive.' : 'Returned to its previous status.',
        });
        loadSignals();
      } catch (e) {
        log.error(`Signal ${action} failed`, e instanceof Error ? e : new Error(String(e)));
        toast({
          title: 'Error',
          description: `Failed to ${action} signal.`,
          variant: 'destructive',
        });
      }
    },
    [toast]
  );

  // Handler for triage view signal processed
  const handleSignalProcessed = useCallback((_signalId: string, _action: 'approved' | 'rejected' | 'skipped') => {
    // Refresh the signals list after processing
    loadSignals();
  }, []);

  // Get signals for triage view (only pending/detected signals, filtered)
  const triageSignals = useMemo(() => {
    return filteredSignals.filter((s) => s.status === 'Detected' || s.status === 'Validated');
  }, [filteredSignals]);

  useEffect(() => {
    loadSignals();
  }, []);

  useEffect(() => {
    setSelectedSignalIds(new Set());
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
  }, [searchQuery, statusFilter, sourceFilter, showArchived]);

  useEffect(() => {
    let filtered = signals;

    // By default, exclude archived signals unless showArchived is true
    if (!showArchived) {
      filtered = filtered.filter((s) => s.status !== 'Archived');
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (s) => s.title.toLowerCase().includes(query) || s.description.toLowerCase().includes(query)
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter((s) => s.status === statusFilter);
    }

    if (sourceFilter !== 'all') {
      filtered = filtered.filter((s) => s.source === sourceFilter);
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'date':
          comparison = b.detectedAt - a.detectedAt;
          break;
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
        case 'source':
          comparison = a.source.localeCompare(b.source);
          break;
        case 'trust':
          comparison = (b.trustScore?.overall || 0) - (a.trustScore?.overall || 0);
          break;
      }
      return sortDirection === 'asc' ? -comparison : comparison;
    });

    setFilteredSignals(sorted);
  }, [searchQuery, statusFilter, sourceFilter, sortField, sortDirection, signals, showArchived]);

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1 shrink-0 lg:pt-1.5">
              <h1 className="text-2xl font-semibold tracking-tight">Signals</h1>
              <p className="text-sm text-muted-foreground">Relevant information gathered by our Agents.</p>
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

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
              <div className="relative">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search signals..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-full sm:w-[130px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="Detected">Detected</SelectItem>
                  <SelectItem value="Validated">Validated</SelectItem>
                  <SelectItem value="Approved">Approved</SelectItem>
                  <SelectItem value="Rejected">Rejected</SelectItem>
                  <SelectItem value="Imported">Imported</SelectItem>
                  {showArchived && <SelectItem value="Archived">Archived</SelectItem>}
                </SelectContent>
              </Select>

              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="h-9 w-full sm:w-[130px]">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="patents">Patents</SelectItem>
                  <SelectItem value="papers">Papers</SelectItem>
                  <SelectItem value="news">News</SelectItem>
                  <SelectItem value="hackernews">Hacker News</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="trends">Trends</SelectItem>
                  <SelectItem value="funding">Funding</SelectItem>
                  <SelectItem value="sec">SEC Filings</SelectItem>
                </SelectContent>
              </Select>

              {/* Group By Dropdown */}
              {viewMode === 'list' && (
                <Select value={groupBy} onValueChange={(value) => handleGroupByChange(value as GroupByOption)}>
                  <SelectTrigger className="h-9 w-full sm:w-[130px]">
                    <Layers className="h-4 w-4 mr-2 text-muted-foreground" />
                    <SelectValue placeholder="Group by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Grouping</SelectItem>
                    <SelectItem value="agent">By Agent</SelectItem>
                    <SelectItem value="source">By Source</SelectItem>
                    <SelectItem value="date">By Date</SelectItem>
                  </SelectContent>
                </Select>
              )}

              {/* View Mode Toggle - Icon only */}
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

              {/* Show Archived Toggle */}
              <div className="flex items-center gap-2">
                <Switch
                  id="show-archived"
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                  aria-label="Show archived signals"
                />
                <Label htmlFor="show-archived" className="text-sm text-muted-foreground whitespace-nowrap">
                  Show archived
                </Label>
              </div>
            </div>
          </div>

          {/* Content */}
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-[52px] w-full" />
              ))}
            </div>
          ) : loadError ? (
            // AUDIT-008: a failed fetch is not "no signals" — surface it honestly.
            <FeedbackEmptyState
              icon={Radio}
              title="Could not load signals"
              description={loadError}
              action={{ label: 'Retry', onClick: () => void loadSignals() }}
            />
          ) : filteredSignals.length === 0 ? (
            <EmptyState hasFilters={hasFilters} onClearFilters={clearFilters} />
          ) : viewMode === 'triage' ? (
            // Triage View - One signal at a time for focused review
            <div className="p-4">
              <SignalTriageQueue
                signals={triageSignals}
                onSignalProcessed={handleSignalProcessed}
                onComplete={() => {
                  toast({
                    title: 'Triage Complete',
                    description: 'All signals have been reviewed.',
                  });
                }}
              />
              {triageSignals.length === 0 && filteredSignals.length > 0 && (
                <div className="text-center py-8">
                  <p className="text-muted-foreground mb-2">
                    No pending signals to triage (showing {filteredSignals.length} already reviewed).
                  </p>
                  <Button variant="outline" onClick={toggleViewMode}>
                    <List className="h-4 w-4 mr-2" />
                    Switch to List View
                  </Button>
                </div>
              )}
            </div>
          ) : groupBy !== 'none' && groupedSignals.length > 0 ? (
            // Grouped List View - Collapsible sections by group
            <>
              <div className="divide-y divide-border">
                {groupedSignals.map((group) => {
                  const expanded = isGroupExpanded(group.key);
                  return (
                    <Collapsible key={group.key} open={expanded} onOpenChange={() => toggleGroupExpansion(group.key)}>
                      <CollapsibleTrigger asChild>
                        <button className="flex items-center justify-between w-full px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left">
                          <div className="flex items-center gap-3">
                            {expanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            )}
                            <span className="font-medium">{group.label}</span>
                            <Badge variant="secondary" className="text-xs">
                              {group.signals.length} signal{group.signals.length !== 1 ? 's' : ''}
                            </Badge>
                          </div>
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <Table>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent border-b border-border">
                              <TableHead className="w-[50px] px-4 py-3">
                                <Checkbox
                                  checked={group.signals.every((s) => selectedSignalIds.has(s.id))}
                                  onCheckedChange={(checked) => {
                                    setSelectedSignalIds((prev) => {
                                      const newSet = new Set(prev);
                                      if (checked) {
                                        group.signals.forEach((s) => newSet.add(s.id));
                                      } else {
                                        group.signals.forEach((s) => newSet.delete(s.id));
                                      }
                                      return newSet;
                                    });
                                  }}
                                  aria-label={`Select all in ${group.label}`}
                                />
                              </TableHead>
                              <TableHead className="px-4 py-3 font-medium">Title</TableHead>
                              <TableHead className="px-4 py-3 font-medium">Source</TableHead>
                              <TableHead className="px-4 py-3 font-medium">Status</TableHead>
                              <TableHead className="px-4 py-3 font-medium">Trust</TableHead>
                              <TableHead className="px-4 py-3 font-medium">Detected</TableHead>
                              <TableHead className="w-[50px] px-4 py-3 font-medium text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.signals.map((signal) => (
                              <TableRow
                                key={signal.id}
                                className={cn(
                                  'group border-b border-border/40 hover:bg-accent/30 transition-colors',
                                  selectedSignalIds.has(signal.id) && 'bg-accent/20'
                                )}
                              >
                                <TableCell className="px-4 py-3">
                                  <Checkbox
                                    checked={selectedSignalIds.has(signal.id)}
                                    onCheckedChange={() => toggleSignalSelection(signal.id)}
                                    aria-label={`Select ${signal.title}`}
                                  />
                                </TableCell>
                                <TableCell className="px-4 py-3">
                                  <Link
                                    href={`/triage/signals/${signal.id}`}
                                    className="block group-hover:text-primary transition-colors"
                                  >
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium line-clamp-1">{signal.title}</span>
                                      {signal.metadata?.possibleDuplicates &&
                                        signal.metadata.possibleDuplicates.length > 0 && (
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <Badge
                                                variant="outline"
                                                className="border-amber-500/50 text-amber-600 shrink-0 gap-1"
                                              >
                                                <Copy className="h-3 w-3" />
                                                {signal.metadata.possibleDuplicates.length}
                                              </Badge>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                              {signal.metadata.possibleDuplicates.length} possible duplicate
                                              {signal.metadata.possibleDuplicates.length > 1 ? 's' : ''} detected
                                            </TooltipContent>
                                          </Tooltip>
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                                      {signal.description}
                                    </div>
                                  </Link>
                                </TableCell>
                                <TableCell className="px-4 py-3">
                                  <div className="text-sm text-muted-foreground line-clamp-2">
                                    {signal.metadata?.agentName || signal.source}
                                  </div>
                                </TableCell>
                                <TableCell className="px-4 py-3">
                                  <SignalStatusBadge status={signal.status} />
                                </TableCell>
                                <TableCell className="px-4 py-3">
                                  {signal.trustScore ? (
                                    <TrustScoreBadge trustScore={signal.trustScore} size="sm" />
                                  ) : (
                                    <span className="text-muted-foreground/40">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                                  {new Date(signal.detectedAt).toLocaleDateString()}
                                </TableCell>
                                <TableCell className="px-4 py-3">
                                  <div className="flex items-center justify-end gap-1">
                                    {displayedVote(signal) && (
                                      <div
                                        className={cn(
                                          'h-8 w-8 flex items-center justify-center rounded-md',
                                          displayedVote(signal) === 'up'
                                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600'
                                            : 'bg-destructive/10 text-destructive'
                                        )}
                                        title={displayedVote(signal) === 'up' ? 'Approved' : 'Rejected'}
                                      >
                                        {displayedVote(signal) === 'up' ? (
                                          <Check className="h-4 w-4" />
                                        ) : (
                                          <X className="h-4 w-4" />
                                        )}
                                      </div>
                                    )}
                                    {!displayedVote(signal) && (
                                      <>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
                                          onClick={() => handleQuickFeedback(signal.id, true)}
                                          title="Approve (one-click)"
                                        >
                                          <Check className="h-4 w-4" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                                          onClick={() => handleQuickFeedback(signal.id, false)}
                                          title="Reject (one-click)"
                                        >
                                          <X className="h-4 w-4" />
                                        </Button>
                                      </>
                                    )}
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8"
                                          aria-label={`Open actions for ${signal.title}`}
                                        >
                                          <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem asChild>
                                          <Link href={`/triage/signals/${signal.id}`}>
                                            <Eye className="h-4 w-4 mr-2" />
                                            View Details
                                          </Link>
                                        </DropdownMenuItem>
                                        {signal.metadata?.url && (
                                          <DropdownMenuItem asChild>
                                            <a href={signal.metadata.url} target="_blank" rel="noopener noreferrer">
                                              <ExternalLink className="h-4 w-4 mr-2" />
                                              Open Source
                                            </a>
                                          </DropdownMenuItem>
                                        )}
                                        {signal.status === 'Archived' ? (
                                          <DropdownMenuItem onClick={() => handleArchiveToggle(signal.id, 'restore')}>
                                            <ArchiveRestore className="h-4 w-4 mr-2" />
                                            Restore
                                          </DropdownMenuItem>
                                        ) : (
                                          <DropdownMenuItem onClick={() => handleArchiveToggle(signal.id, 'archive')}>
                                            <Archive className="h-4 w-4 mr-2" />
                                            Archive
                                          </DropdownMenuItem>
                                        )}
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>

              <DataPagination
                pageIndex={pagination.pageIndex}
                pageSize={pagination.pageSize}
                totalCount={filteredSignals.length}
                onPageChange={(pageIndex) => setPagination((prev) => ({ ...prev, pageIndex }))}
                onPageSizeChange={(pageSize) => setPagination((prev) => ({ ...prev, pageSize }))}
                itemLabel="signals"
              />
            </>
          ) : (
            // List View - Table with pagination (no grouping)
            <>
              <div className="relative overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow className="hover:bg-transparent border-b border-border">
                      <TableHead className="w-[50px] px-4 py-3">
                        <Checkbox
                          checked={isAllSelected}
                          onCheckedChange={toggleSelectAll}
                          aria-label="Select all"
                          className={cn(isSomeSelected && 'opacity-50')}
                        />
                      </TableHead>
                      <SortableHead
                        label="Title"
                        field="title"
                        currentField={sortField}
                        currentDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHead
                        label="Source"
                        field="source"
                        currentField={sortField}
                        currentDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHead
                        label="Status"
                        field="status"
                        currentField={sortField}
                        currentDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHead
                        label="Trust"
                        field="trust"
                        currentField={sortField}
                        currentDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <SortableHead
                        label="Detected"
                        field="date"
                        currentField={sortField}
                        currentDirection={sortDirection}
                        onSort={handleSort}
                      />
                      <TableHead className="w-[50px] px-4 py-3 font-medium text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedSignals.map((signal) => (
                      <TableRow
                        key={signal.id}
                        className={cn(
                          'group cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
                          selectedSignalIds.has(signal.id) && 'bg-accent/20'
                        )}
                      >
                        <TableCell className="px-4 py-3">
                          <Checkbox
                            checked={selectedSignalIds.has(signal.id)}
                            onCheckedChange={() => toggleSignalSelection(signal.id)}
                            aria-label={`Select ${signal.title}`}
                          />
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <Link
                            href={`/triage/signals/${signal.id}`}
                            className="block group-hover:text-primary transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-medium line-clamp-1">{signal.title}</span>
                              {signal.metadata?.possibleDuplicates && signal.metadata.possibleDuplicates.length > 0 && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge
                                      variant="outline"
                                      className="border-amber-500/50 text-amber-600 shrink-0 gap-1"
                                    >
                                      <Copy className="h-3 w-3" />
                                      {signal.metadata.possibleDuplicates.length}
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {signal.metadata.possibleDuplicates.length} possible duplicate
                                    {signal.metadata.possibleDuplicates.length > 1 ? 's' : ''} detected
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                              {signal.description}
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <div className="text-sm text-muted-foreground line-clamp-2">
                            {signal.metadata?.agentName || signal.source}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <SignalStatusBadge status={signal.status} />
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          {signal.trustScore ? (
                            <TrustScoreBadge trustScore={signal.trustScore} size="sm" />
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                          {new Date(signal.detectedAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {/* Show vote indicator if already voted */}
                            {displayedVote(signal) && (
                              <div
                                className={cn(
                                  'h-8 w-8 flex items-center justify-center rounded-md',
                                  displayedVote(signal) === 'up'
                                    ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600'
                                    : 'bg-destructive/10 text-destructive'
                                )}
                                title={displayedVote(signal) === 'up' ? 'Approved' : 'Rejected'}
                              >
                                {displayedVote(signal) === 'up' ? (
                                  <Check className="h-4 w-4" />
                                ) : (
                                  <X className="h-4 w-4" />
                                )}
                              </div>
                            )}
                            {/* Show approve/reject buttons if not yet voted */}
                            {!displayedVote(signal) && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
                                  onClick={() => handleQuickFeedback(signal.id, true)}
                                  title="Approve (one-click)"
                                >
                                  <Check className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                                  onClick={() => handleQuickFeedback(signal.id, false)}
                                  title="Reject (one-click)"
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={`Open actions for ${signal.title}`}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                  <Link href={`/triage/signals/${signal.id}`}>
                                    <Eye className="h-4 w-4 mr-2" />
                                    View Details
                                  </Link>
                                </DropdownMenuItem>
                                {signal.metadata?.url && (
                                  <DropdownMenuItem asChild>
                                    <a href={signal.metadata.url} target="_blank" rel="noopener noreferrer">
                                      <ExternalLink className="h-4 w-4 mr-2" />
                                      Open Source
                                    </a>
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <DataPagination
                pageIndex={pagination.pageIndex}
                pageSize={pagination.pageSize}
                totalCount={filteredSignals.length}
                onPageChange={(pageIndex) => setPagination((prev) => ({ ...prev, pageIndex }))}
                onPageSizeChange={(pageSize) => setPagination((prev) => ({ ...prev, pageSize }))}
                itemLabel="signals"
              />
            </>
          )}
        </PageContent>
      </PageShell>

      {/* Bulk Action Toolbar — shared floating bottom toolbar (same surface as
          companies/infographics). Approve/Reject/Delete open the same
          confirmation dialog the old top bar used; the built-in X clears
          the selection. */}
      <BulkActionToolbar
        selectedCount={selectedCount}
        entityType="signal"
        onClearSelection={() => setSelectedSignalIds(new Set())}
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
              onClick={() => setBulkActionDialog('archive')}
              disabled={isBulkProcessing}
              data-testid="bulk-archive"
            >
              {isBulkProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4 mr-1" />}
              Archive
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

      {/* Bulk Action Confirmation Dialog */}
      <AlertDialog open={bulkActionDialog !== null} onOpenChange={() => setBulkActionDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkActionDialog === 'approve' && `Approve ${selectedCount} Signal${selectedCount !== 1 ? 's' : ''}?`}
              {bulkActionDialog === 'reject' && `Reject ${selectedCount} Signal${selectedCount !== 1 ? 's' : ''}?`}
              {bulkActionDialog === 'archive' && `Archive ${selectedCount} Signal${selectedCount !== 1 ? 's' : ''}?`}
              {bulkActionDialog === 'delete' && `Delete ${selectedCount} Signal${selectedCount !== 1 ? 's' : ''}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkActionDialog === 'approve' &&
                `This will mark ${selectedCount} signal${selectedCount !== 1 ? 's' : ''} as approved.`}
              {bulkActionDialog === 'reject' &&
                `This will mark ${selectedCount} signal${selectedCount !== 1 ? 's' : ''} as rejected.`}
              {bulkActionDialog === 'archive' &&
                `This will move ${selectedCount} signal${selectedCount !== 1 ? 's' : ''} to the archive. You can restore ${selectedCount !== 1 ? 'them' : 'it'} later.`}
              {bulkActionDialog === 'delete' &&
                `This will permanently delete ${selectedCount} signal${selectedCount !== 1 ? 's' : ''}. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bulkActionDialog && processBulkAction(bulkActionDialog)}
              className={cn(
                bulkActionDialog === 'approve' && 'bg-emerald-600 hover:bg-emerald-700',
                (bulkActionDialog === 'reject' || bulkActionDialog === 'delete') &&
                  'bg-destructive hover:bg-destructive/90'
              )}
            >
              {bulkActionDialog === 'approve' && 'Approve All'}
              {bulkActionDialog === 'reject' && 'Reject All'}
              {bulkActionDialog === 'archive' && 'Archive All'}
              {bulkActionDialog === 'delete' && 'Delete All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SmartLayout>
  );
}
