'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Rocket,
  Search,
  LayoutGrid,
  LayoutList,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Calendar,
  TrendingUp,
  MoreHorizontal,
  Eye,
  Pencil,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
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
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';

import { initiativeKeys, orgUnitKeys } from '@/lib/query-keys';
import { useEntityNotes } from '@/hooks/useEntityNotes';
import { buildTargetSnapshot } from '@/lib/relation-snapshot';
import { getInitiatives, deleteInitiative } from '@/lib/initiatives';
import { resolveInitiativeCreateOutcome, resolveInitiativeUpdateOutcome } from '@/lib/mutation-outcome/initiative';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';
import { getOrgUnits } from '@/lib/org-units';
import { getRelationsForEntity, createRelation, deleteRelation } from '@/lib/relations';
import type {
  Initiative,
  InitiativeStatus,
  InitiativePriority,
  CreateInitiativeInput,
  EntityType,
  RelationType,
  EntitySnapshot,
  Relation,
} from '@/lib/types';
import { InitiativeSheet } from '@/components/sheets/InitiativeSheet';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useControlledSheet } from '@/hooks/useSheetUrl';
import { cn } from '@/lib/utils';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { formatEnumLabel } from '@/lib/enum-label';
import { createLogger } from '@/lib/logger';
import { deleteEntitiesWithExactOutcomes } from '@/lib/entity-delete-outcomes';
import { formatDate, formatDateRange } from './date-range';

const log = createLogger('initiatives-page');

// Leading chip icon — canon color/glyph for the initiative entity type (CONV-CHIP).
const ChipIcon = entityIcon('initiative');

// ============================================================================
// CONSTANTS
// ============================================================================

const INITIATIVE_STATUSES: { value: InitiativeStatus; label: string }[] = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'approved', label: 'Approved' },
  { value: 'active', label: 'Active' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const INITIATIVE_PRIORITIES: { value: InitiativePriority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

type ViewMode = 'table' | 'grid';
type SortField = 'name' | 'status' | 'priority' | 'budget' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

// ============================================================================
// HELPERS
// ============================================================================

function getStatusColor(status: InitiativeStatus): string {
  const colors: Record<InitiativeStatus, string> = {
    proposed: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
    approved: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    active: 'bg-green-500/10 text-green-500 border-green-500/20',
    on_hold: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    completed: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    cancelled: 'bg-red-500/10 text-red-500 border-red-500/20',
  };
  return colors[status] || 'bg-muted text-muted-foreground';
}

function getPriorityColor(priority: InitiativePriority): string {
  const colors: Record<InitiativePriority, string> = {
    critical: 'bg-red-500/10 text-red-500 border-red-500/20',
    high: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
    medium: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    low: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
  };
  return colors[priority] || 'bg-muted text-muted-foreground';
}

function formatStatusLabel(status: InitiativeStatus | undefined): string {
  if (!status) return 'Unknown';
  const labels: Record<InitiativeStatus, string> = {
    proposed: 'Proposed',
    approved: 'Approved',
    active: 'Active',
    on_hold: 'On Hold',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  // CONV-ENUM: fall back to formatEnumLabel (not the raw value) so an
  // unexpected/legacy status never leaks a raw slug into the badge.
  return labels[status] || formatEnumLabel(status);
}

function formatPriorityLabel(priority: InitiativePriority): string {
  const labels: Record<InitiativePriority, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };
  return labels[priority] || formatEnumLabel(priority);
}

function formatCurrency(amount: number | undefined): string {
  if (amount === undefined || amount === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
}

function getBudgetUtilization(budget?: number, actualSpend?: number): number {
  if (!budget || budget === 0) return 0;
  if (!actualSpend) return 0;
  return Math.min(100, Math.round((actualSpend / budget) * 100));
}

// ============================================================================
// SKELETON COMPONENTS
// ============================================================================

function TableSkeleton() {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Skeleton className="h-4 w-4" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-24" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-20" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-24" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-20" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-4" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-40" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-20 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-16 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full mt-2" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ============================================================================
// SORTABLE HEADER COMPONENT
// ============================================================================

interface SortableHeaderProps {
  label: string;
  sortKey: SortField;
  currentSort: { key: SortField; direction: SortDirection } | null;
  onSort: (key: SortField) => void;
  className?: string;
}

function SortableHeader({ label, sortKey, currentSort, onSort, className }: SortableHeaderProps) {
  const isActive = currentSort?.key === sortKey;
  const direction = isActive ? currentSort.direction : null;

  return (
    <button
      onClick={() => onSort(sortKey)}
      className={cn(
        'flex items-center gap-1 font-medium hover:text-foreground transition-colors',
        isActive ? 'text-foreground' : 'text-muted-foreground',
        className
      )}
    >
      {label}
      {direction === 'asc' ? (
        <ArrowUp className="h-3.5 w-3.5" />
      ) : direction === 'desc' ? (
        <ArrowDown className="h-3.5 w-3.5" />
      ) : (
        <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
      )}
    </button>
  );
}

// ============================================================================
// DATA PAGINATION COMPONENT
// ============================================================================

interface DataPaginationProps {
  pageIndex: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  itemLabel?: string;
}

function DataPagination({
  pageIndex,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
  itemLabel = 'initiatives',
}: DataPaginationProps) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const startIndex = pageIndex * pageSize + 1;
  const endIndex = Math.min((pageIndex + 1) * pageSize, totalCount);

  const canGoPrevious = pageIndex > 0;
  const canGoNext = pageIndex < totalPages - 1;

  return (
    <div className="flex flex-col gap-4 px-4 py-3 border-t border-border sm:flex-row sm:items-center sm:justify-between">
      {/* Left: Rows per page */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Rows per page</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => {
            onPageSizeChange(Number(value));
            onPageChange(0);
          }}
        >
          <SelectTrigger className="h-8 w-[70px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10</SelectItem>
            <SelectItem value="20">20</SelectItem>
            <SelectItem value="50">50</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Right: Page info and navigation */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">
          {totalCount > 0 ? `${startIndex}–${endIndex} of ${totalCount} ${itemLabel}` : `0 ${itemLabel}`}
        </span>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(0)}
            disabled={!canGoPrevious}
          >
            <ChevronsLeft className="h-4 w-4" />
            <span className="sr-only">First page</span>
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(pageIndex - 1)}
            disabled={!canGoPrevious}
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Previous page</span>
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(pageIndex + 1)}
            disabled={!canGoNext}
          >
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Next page</span>
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(totalPages - 1)}
            disabled={!canGoNext}
          >
            <ChevronsRight className="h-4 w-4" />
            <span className="sr-only">Last page</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function InitiativesPage() {
  const graphSync = useLibraryEntityGraphSync<Initiative>({
    entityType: 'initiative',
    entityTypeLabel: 'initiative',
    getName: (initiative) => initiative.name,
  });
  const queryClient = useQueryClient();

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<InitiativeStatus[]>([]);
  const [selectedPriorities, setSelectedPriorities] = useState<InitiativePriority[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: SortField; direction: SortDirection } | null>({
    key: 'priority',
    direction: 'asc',
  });

  // Pagination (0-indexed)
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sheet state — edit mode is URL-controlled (`?initiative=<id>`, see below);
  // the create flow has no entity id to put in the URL, so it stays local.
  const [isCreating, setIsCreating] = useState(false);

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [initiativeToDelete, setInitiativeToDelete] = useState<Initiative | null>(null);

  // Relations state for the sheet
  const [initiativeRelations, setInitiativeRelations] = useState<Record<string, Relation[]>>({});

  // Fetch initiatives
  const {
    data: initiatives = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: initiativeKeys.all,
    queryFn: getInitiatives,
  });

  // Fetch org units for the dropdown
  const { data: orgUnits = [] } = useQuery({
    queryKey: orgUnitKeys.all,
    queryFn: getOrgUnits,
  });

  // Listen for data refresh events from AI Assistant
  useDataRefresh(['initiatives', 'relations'], () => {
    log.info('Auto-refreshing data after AI Assistant action');
    queryClient.invalidateQueries({ queryKey: initiativeKeys.all });
  });

  // URL-controlled edit sheet. Param name must stay in sync with
  // ENTITY_SHEET_PARAMS in entity-links.ts so graph / command-palette deep
  // links open the sheet directly.
  const {
    selectedEntity: editingInitiative,
    isOpen: isSheetOpenFromUrl,
    open: openInitiativeSheet,
    close: closeInitiativeSheet,
  } = useControlledSheet({
    entities: initiatives,
    getId: (initiative) => initiative.id,
    paramName: 'initiative',
  });

  const sheetOpen = isCreating || (isSheetOpenFromUrl && !!editingInitiative);

  // Notes for the selected initiative (UX-025) — shared entity-notes contract.
  const {
    notes: initiativeNotes,
    onAddNote: onAddInitiativeNote,
    onUpdateNote: onUpdateInitiativeNote,
    onDeleteNote: onDeleteInitiativeNote,
  } = useEntityNotes('initiatives', editingInitiative?.id);

  /** Back-compat setter for the sheet's onOpenChange: close tears down both modes. */
  const setSheetOpen = useCallback(
    (open: boolean) => {
      if (open) {
        // Edit opens go through handleEdit with a target entity; an
        // untargeted `true` can only mean the create sheet.
        setIsCreating(true);
      } else {
        setIsCreating(false);
        closeInitiativeSheet();
      }
    },
    [closeInitiativeSheet]
  );

  // Load relations whenever the edited initiative changes — covers both
  // row-click opens and URL deep links (which never pass through handleEdit).
  useEffect(() => {
    if (!editingInitiative) return;
    const initiativeId = editingInitiative.id;
    let cancelled = false;
    getRelationsForEntity(initiativeId)
      .then((relations) => {
        if (cancelled) return;
        setInitiativeRelations((prev) => ({ ...prev, [initiativeId]: relations }));
      })
      .catch((error) => {
        log.error('Failed to fetch relations', error instanceof Error ? error : new Error(String(error)), {
          initiativeId,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [editingInitiative?.id]);

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteInitiative,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: initiativeKeys.all });
      toast.success('Initiative deleted');
      setDeleteDialogOpen(false);
      setInitiativeToDelete(null);
    },
    onError: (err) => {
      toast.error('Failed to delete initiative', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });

  // Bulk delete mutation
  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => deleteEntitiesWithExactOutcomes(ids, deleteInitiative),
    onSuccess: ({ deletedIds, failed }) => {
      setSelectedIds(new Set(failed.map(({ id }) => id)));
      if (deletedIds.length > 0) {
        toast.success(`${deletedIds.length} ${deletedIds.length === 1 ? 'initiative' : 'initiatives'} deleted`);
      }
      if (failed.length > 0) {
        const firstError = failed[0]?.error;
        toast.error(`${failed.length} ${failed.length === 1 ? 'initiative' : 'initiatives'} not deleted`, {
          description: firstError instanceof Error ? firstError.message : 'Retry after resolving dependencies.',
        });
      }
    },
    onError: (err) => {
      toast.error('Failed to delete initiatives', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: initiativeKeys.all });
    },
  });

  // Save handler for InitiativeSheet
  const handleSave = useCallback(
    async (data: {
      name: string;
      description: string;
      ownerOrgUnitId: string;
      ownerOrgUnitName?: string;
      sponsorName?: string;
      status: string;
      priority: string;
      startDate?: number;
      targetEndDate?: number;
      actualEndDate?: number;
      budget?: number;
      actualSpend?: number;
      tags: string[];
      milestones?: Array<{
        id: string;
        title: string;
        targetDate?: number;
        completedDate?: number;
      }>;
    }) => {
      // Transform milestones to include status field
      const milestones = data.milestones?.map((m) => ({
        id: m.id,
        title: m.title,
        targetDate: m.targetDate,
        completedDate: m.completedDate,
        status: m.completedDate
          ? ('completed' as const)
          : m.targetDate && m.targetDate < Date.now()
            ? ('missed' as const)
            : ('pending' as const),
      }));

      // Look up org unit name from ID if not provided
      const ownerOrgUnitName = data.ownerOrgUnitName || orgUnits.find((u) => u.id === data.ownerOrgUnitId)?.name || '';

      const initiativeData = {
        name: data.name,
        description: data.description,
        ownerOrgUnitId: data.ownerOrgUnitId,
        ownerOrgUnitName,
        sponsorName: data.sponsorName,
        status: data.status as InitiativeStatus,
        priority: data.priority as InitiativePriority,
        startDate: data.startDate,
        targetEndDate: data.targetEndDate,
        actualEndDate: data.actualEndDate,
        budget: data.budget,
        actualSpend: data.actualSpend,
        tags: data.tags || [],
        milestones,
      };

      // GRAPH-058: a committed write whose graph handoff was lost is reported as
      // saved-locally with a retry, never as a failed save.
      if (editingInitiative) {
        // Update existing
        const outcome = await resolveInitiativeUpdateOutcome(editingInitiative, initiativeData);
        const status = graphSync.applyOutcome(outcome, { applyCommitted: () => undefined, success: null });
        if (status === 'saved-and-queued') toast.success('Initiative updated');
      } else {
        // Create new
        const createData: CreateInitiativeInput = {
          ...initiativeData,
          linkedStrategyIds: [],
          linkedPrototypeIds: [],
          linkedPainPointIds: [],
        };
        const outcome = await resolveInitiativeCreateOutcome(createData);
        const status = graphSync.applyOutcome(outcome, { applyCommitted: () => undefined, success: null });
        if (status === 'saved-and-queued') toast.success('Initiative created');
      }
      queryClient.invalidateQueries({ queryKey: initiativeKeys.all });
      setSheetOpen(false);
    },
    [editingInitiative, queryClient, orgUnits, setSheetOpen, graphSync]
  );

  // Filter and sort initiatives
  const filteredInitiatives = useMemo(() => {
    let result = [...initiatives];

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (initiative) =>
          initiative.name.toLowerCase().includes(query) ||
          initiative.description?.toLowerCase().includes(query) ||
          initiative.ownerOrgUnitName?.toLowerCase().includes(query) ||
          initiative.sponsorName?.toLowerCase().includes(query)
      );
    }

    // Apply status filter
    if (selectedStatuses.length > 0) {
      result = result.filter((initiative) => selectedStatuses.includes(initiative.status));
    }

    // Apply priority filter
    if (selectedPriorities.length > 0) {
      result = result.filter((initiative) => selectedPriorities.includes(initiative.priority));
    }

    // Apply sorting
    const priorityOrder: Record<InitiativePriority, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };

    const statusOrder: Record<InitiativeStatus, number> = {
      active: 0,
      approved: 1,
      proposed: 2,
      on_hold: 3,
      completed: 4,
      cancelled: 5,
    };

    if (sortConfig) {
      result.sort((a, b) => {
        let comparison = 0;

        switch (sortConfig.key) {
          case 'name':
            comparison = a.name.localeCompare(b.name);
            break;
          case 'status':
            comparison = statusOrder[a.status] - statusOrder[b.status];
            break;
          case 'priority':
            comparison = priorityOrder[a.priority] - priorityOrder[b.priority];
            break;
          case 'budget':
            comparison = (a.budget || 0) - (b.budget || 0);
            break;
          case 'updatedAt':
            comparison = a.updatedAt - b.updatedAt;
            break;
        }

        return sortConfig.direction === 'asc' ? comparison : -comparison;
      });
    }

    return result;
  }, [initiatives, searchQuery, selectedStatuses, selectedPriorities, sortConfig]);

  // Paginate
  const paginatedInitiatives = useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredInitiatives.slice(start, start + pageSize);
  }, [filteredInitiatives, pageIndex, pageSize]);

  // Sorted initiatives for DataPagination
  const sortedInitiatives = filteredInitiatives;

  // Handlers
  const handleCreateNew = useCallback(() => {
    closeInitiativeSheet();
    setIsCreating(true);
  }, [closeInitiativeSheet]);

  // Relations load via the editingInitiative effect above.
  const handleEdit = useCallback(
    (initiative: Initiative) => {
      setIsCreating(false);
      openInitiativeSheet(initiative);
    },
    [openInitiativeSheet]
  );

  const handleAddRelation = useCallback(
    async (targetId: string, targetType: EntityType, relationType: RelationType) => {
      if (!editingInitiative) return;

      try {
        // Build source snapshot (initiative)
        const sourceSnapshot: EntitySnapshot = {
          type: 'initiative',
          id: editingInitiative.id,
          name: editingInitiative.name,
          description: editingInitiative.description,
          status: editingInitiative.status,
          snapshotAt: Date.now(),
        };

        // Resolve the canonical target snapshot with the real name.
        // createRelation stores the snapshot verbatim, so an empty name would
        // persist, break the relation card render, and make UI unlink impossible
        // (UX-034). A missing target is a visible failure, not a silent write.
        const targetSnapshot = await buildTargetSnapshot(targetId, targetType);
        if (!targetSnapshot) {
          toast.error('Could not find the entity to link');
          return;
        }

        await createRelation({
          relationType,
          sourceSnapshot,
          targetSnapshot,
        });

        // Refresh relations for the current initiative
        const updatedRelations = await getRelationsForEntity(editingInitiative.id);
        setInitiativeRelations((prev) => ({
          ...prev,
          [editingInitiative.id]: updatedRelations,
        }));

        toast.success('Relation added');
      } catch (error) {
        log.error('Failed to add relation', error instanceof Error ? error : new Error(String(error)));
        toast.error('Failed to add relation');
      }
    },
    [editingInitiative]
  );

  const handleRemoveRelation = useCallback(
    async (relationId: string) => {
      try {
        await deleteRelation(relationId);

        if (editingInitiative) {
          // Refresh relations for the current initiative
          const updatedRelations = await getRelationsForEntity(editingInitiative.id);
          setInitiativeRelations((prev) => ({
            ...prev,
            [editingInitiative.id]: updatedRelations,
          }));
        }

        toast.success('Relation removed');
      } catch (error) {
        log.error('Failed to remove relation', error instanceof Error ? error : new Error(String(error)));
        toast.error('Failed to remove relation');
      }
    },
    [editingInitiative]
  );

  const handleConfirmDelete = useCallback(() => {
    if (initiativeToDelete) {
      deleteMutation.mutate(initiativeToDelete.id);
    }
  }, [initiativeToDelete, deleteMutation]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size > 0) {
      bulkDeleteMutation.mutate(Array.from(selectedIds));
    }
  }, [selectedIds, bulkDeleteMutation]);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === paginatedInitiatives.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedInitiatives.map((i) => i.id)));
    }
  }, [paginatedInitiatives, selectedIds.size]);

  const handleSelectOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSort = useCallback((key: SortField) => {
    setSortConfig((prev) => {
      if (prev?.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  }, []);

  const handleDeleteClick = useCallback((initiative: Initiative) => {
    setInitiativeToDelete(initiative);
    setDeleteDialogOpen(true);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setSelectedStatuses([]);
    setSelectedPriorities([]);
    setPageIndex(0);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setPageIndex(0);
  }, []);

  const toggleStatusFilter = useCallback((status: InitiativeStatus) => {
    setSelectedStatuses((prev) => {
      const next = prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status];
      return next;
    });
    setPageIndex(0);
  }, []);

  const togglePriorityFilter = useCallback((priority: InitiativePriority) => {
    setSelectedPriorities((prev) => {
      const next = prev.includes(priority) ? prev.filter((p) => p !== priority) : [...prev, priority];
      return next;
    });
    setPageIndex(0);
  }, []);

  // Render error state
  if (error) {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent>
            <EmptyState
              icon={Rocket}
              title="Failed to load initiatives"
              description={error instanceof Error ? error.message : 'Unknown error occurred'}
              action={{
                label: 'Try Again',
                onClick: () => queryClient.invalidateQueries({ queryKey: initiativeKeys.all }),
              }}
            />
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  const hasFilters = searchQuery || selectedStatuses.length > 0 || selectedPriorities.length > 0;

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row: Title + Filters + Actions */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            {/* Left: Title */}
            <div className="space-y-1 shrink-0">
              <h1 className="text-2xl font-semibold tracking-tight">Initiatives</h1>
              <p className="text-sm text-muted-foreground">Strategic projects bridging strategy to execution.</p>
            </div>

            {/* Right: Search, Filters, Actions */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search initiatives..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              {/* Status Filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2">
                    Status
                    {selectedStatuses.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {selectedStatuses.length}
                      </Badge>
                    )}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {INITIATIVE_STATUSES.map((status) => (
                    <DropdownMenuItem
                      key={status.value}
                      onClick={() => toggleStatusFilter(status.value)}
                      className="gap-2"
                    >
                      <Checkbox checked={selectedStatuses.includes(status.value)} className="pointer-events-none" />
                      {status.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Priority Filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2">
                    Priority
                    {selectedPriorities.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {selectedPriorities.length}
                      </Badge>
                    )}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {INITIATIVE_PRIORITIES.map((priority) => (
                    <DropdownMenuItem
                      key={priority.value}
                      onClick={() => togglePriorityFilter(priority.value)}
                      className="gap-2"
                    >
                      <Checkbox checked={selectedPriorities.includes(priority.value)} className="pointer-events-none" />
                      {priority.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {hasFilters && (
                <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
                  Clear
                </Button>
              )}

              {/* View Toggle */}
              <div className="flex items-center rounded-md border">
                <Button
                  variant={viewMode === 'table' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('table')}
                  aria-label="Table view"
                  className="rounded-r-none h-9 px-3"
                >
                  <LayoutList className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setViewMode('grid')}
                  aria-label="Grid view"
                  className="rounded-l-none h-9 px-3"
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
              </div>

              {/* Add Button */}
              <Button onClick={handleCreateNew} size="sm" className="h-9">
                +
              </Button>
            </div>
          </div>

          {/* Bulk actions */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-4 p-3 mx-4 mt-4 bg-muted rounded-lg">
              <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDelete}
                disabled={bulkDeleteMutation.isPending}
                className="gap-2"
              >
                <Trash2 className="h-4 w-4" />
                Delete Selected
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                Clear Selection
              </Button>
            </div>
          )}

          {/* Content */}
          <EntityGraphSyncRecoveryBanner
            recoveries={graphSync.recoveries}
            maxRetryAttempts={graphSync.maxRetryAttempts}
            entityTypeLabel={graphSync.entityTypeLabel}
            getLabel={graphSync.getRecoveryLabel}
            onRetry={graphSync.retryGraphSync}
          />

          {isLoading ? (
            viewMode === 'table' ? (
              <TableSkeleton />
            ) : (
              <GridSkeleton />
            )
          ) : filteredInitiatives.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title={hasFilters ? 'No initiatives match your filters' : 'No initiatives yet'}
              description={
                hasFilters
                  ? 'Try adjusting your search or filters'
                  : 'Create your first initiative to start tracking strategic projects'
              }
              action={
                hasFilters
                  ? { label: 'Clear Filters', onClick: clearFilters }
                  : { label: 'New initiative', onClick: handleCreateNew }
              }
            />
          ) : viewMode === 'table' ? (
            <>
              {/* Table View */}
              <div className="relative overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow className="hover:bg-transparent border-b border-border">
                      <TableHead className="w-[50px] px-4 py-3">
                        <Checkbox
                          checked={paginatedInitiatives.length > 0 && selectedIds.size === paginatedInitiatives.length}
                          onCheckedChange={handleSelectAll}
                        />
                      </TableHead>
                      <TableHead className="px-4 py-3">
                        <SortableHeader
                          label="Initiative"
                          sortKey="name"
                          currentSort={sortConfig}
                          onSort={handleSort}
                        />
                      </TableHead>
                      <TableHead className="px-4 py-3">
                        <SortableHeader label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} />
                      </TableHead>
                      <TableHead className="px-4 py-3">
                        <SortableHeader
                          label="Priority"
                          sortKey="priority"
                          currentSort={sortConfig}
                          onSort={handleSort}
                        />
                      </TableHead>
                      <TableHead className="px-4 py-3">
                        <SortableHeader label="Budget" sortKey="budget" currentSort={sortConfig} onSort={handleSort} />
                      </TableHead>
                      <TableHead className="px-4 py-3">Timeline</TableHead>
                      <TableHead className="px-4 py-3">Owner</TableHead>
                      <TableHead className="w-[50px] px-4 py-3"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedInitiatives.map((initiative) => (
                      <TableRow
                        key={initiative.id}
                        className={cn(
                          'cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
                          selectedIds.has(initiative.id) && 'bg-accent/20'
                        )}
                        onClick={() => handleEdit(initiative)}
                      >
                        <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedIds.has(initiative.id)}
                            onCheckedChange={() => handleSelectOne(initiative.id)}
                          />
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                                ENTITY_COLORS.initiative.bg
                              )}
                            >
                              <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.initiative.text)} />
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium truncate">{initiative.name}</div>
                              {initiative.description && (
                                <div className="text-sm text-muted-foreground line-clamp-1">
                                  {initiative.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <Badge variant="outline" className={getStatusColor(initiative.status)}>
                            {formatStatusLabel(initiative.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <Badge variant="outline" className={getPriorityColor(initiative.priority)}>
                            {formatPriorityLabel(initiative.priority)}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <div className="space-y-1">
                            <div className="text-sm whitespace-nowrap">
                              {initiative.budget != null ? (
                                formatCurrency(initiative.budget)
                              ) : (
                                <span className="text-muted-foreground/40">—</span>
                              )}
                            </div>
                            {initiative.budget && (
                              <div className="flex items-center gap-2">
                                <Progress
                                  value={getBudgetUtilization(initiative.budget, initiative.actualSpend)}
                                  className="h-1.5 w-20"
                                />
                                <span className="text-xs text-muted-foreground">
                                  {getBudgetUtilization(initiative.budget, initiative.actualSpend)}%
                                </span>
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          {initiative.startDate || initiative.targetEndDate ? (
                            <div className="flex items-center gap-1.5 text-sm text-muted-foreground whitespace-nowrap">
                              <Calendar className="h-3.5 w-3.5 shrink-0" />
                              <span>{formatDateRange(initiative.startDate, initiative.targetEndDate)}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3 max-w-[160px]">
                          {initiative.ownerOrgUnitName || initiative.sponsorName ? (
                            <div className="min-w-0">
                              {initiative.ownerOrgUnitName ? (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="text-sm truncate max-w-[160px]">
                                        {initiative.ownerOrgUnitName}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{initiative.ownerOrgUnitName}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              ) : (
                                <div className="text-sm text-muted-foreground/40">—</div>
                              )}
                              {initiative.sponsorName && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <div className="text-xs text-muted-foreground truncate max-w-[160px]">
                                        {initiative.sponsorName}
                                      </div>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{initiative.sponsorName}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleEdit(initiative)}>
                                <Eye className="h-4 w-4 mr-2" />
                                View
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleEdit(initiative)}>
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleDeleteClick(initiative)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="mt-4">
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={sortedInitiatives.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="initiatives"
                />
              </div>
            </>
          ) : (
            <>
              {/* Grid View */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {paginatedInitiatives.map((initiative) => (
                  <Card
                    key={initiative.id}
                    className="cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleEdit(initiative)}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                            ENTITY_COLORS.initiative.bg
                          )}
                        >
                          <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.initiative.text)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between">
                            <CardTitle className="text-lg truncate">{initiative.name}</CardTitle>
                            <Checkbox
                              checked={selectedIds.has(initiative.id)}
                              onCheckedChange={() => handleSelectOne(initiative.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="ml-2"
                            />
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className={getStatusColor(initiative.status)}>
                              {formatStatusLabel(initiative.status)}
                            </Badge>
                            <Badge variant="outline" className={getPriorityColor(initiative.priority)}>
                              {formatPriorityLabel(initiative.priority)}
                            </Badge>
                          </div>
                        </div>
                      </div>
                      {initiative.description && (
                        <CardDescription className="line-clamp-2 mt-2">{initiative.description}</CardDescription>
                      )}
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {/* Budget */}
                        {initiative.budget && (
                          <div>
                            <div className="flex justify-between text-sm mb-1">
                              <span className="text-muted-foreground">Budget</span>
                              <span>{formatCurrency(initiative.budget)}</span>
                            </div>
                            <Progress
                              value={getBudgetUtilization(initiative.budget, initiative.actualSpend)}
                              className="h-2"
                            />
                            <div className="flex justify-between text-xs text-muted-foreground mt-1">
                              <span>Spent: {formatCurrency(initiative.actualSpend)}</span>
                              <span>{getBudgetUtilization(initiative.budget, initiative.actualSpend)}%</span>
                            </div>
                          </div>
                        )}

                        {/* Timeline */}
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Calendar className="h-4 w-4" />
                          <span>
                            {initiative.startDate ? formatDate(initiative.startDate) : 'Not started'}
                            {initiative.targetEndDate && ` → ${formatDate(initiative.targetEndDate)}`}
                          </span>
                        </div>

                        {/* Owner */}
                        {initiative.ownerOrgUnitName && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <TrendingUp className="h-4 w-4" />
                            <span>{initiative.ownerOrgUnitName}</span>
                          </div>
                        )}
                      </div>

                      {initiative.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-3">
                          {initiative.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                          {initiative.tags.length > 3 && (
                            <Badge variant="secondary" className="text-xs">
                              +{initiative.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Grid pagination */}
              <div className="mt-4">
                <DataPagination
                  pageIndex={pageIndex}
                  pageSize={pageSize}
                  totalCount={sortedInitiatives.length}
                  onPageChange={setPageIndex}
                  onPageSizeChange={setPageSize}
                  itemLabel="initiatives"
                />
              </div>
            </>
          )}

          {/* Initiative Sheet */}
          <InitiativeSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            initiative={editingInitiative}
            onSave={handleSave}
            onDelete={
              editingInitiative
                ? async () => {
                    await deleteInitiative(editingInitiative.id);
                    toast.success('Initiative deleted');
                    queryClient.invalidateQueries({ queryKey: initiativeKeys.all });
                    setSheetOpen(false);
                  }
                : undefined
            }
            orgUnits={orgUnits.map((unit) => ({ id: unit.id, name: unit.name }))}
            relations={editingInitiative ? initiativeRelations[editingInitiative.id] || [] : []}
            onAddRelation={handleAddRelation}
            onRemoveRelation={handleRemoveRelation}
            notes={initiativeNotes}
            onAddNote={onAddInitiativeNote}
            onUpdateNote={onUpdateInitiativeNote}
            onDeleteNote={onDeleteInitiativeNote}
          />

          {/* Delete Confirmation Dialog */}
          <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Initiative</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete &quot;{initiativeToDelete?.name}&quot;? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleConfirmDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
