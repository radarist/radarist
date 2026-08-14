'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Building2,
  Users,
  Search,
  LayoutGrid,
  LayoutList,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  MapPin,
  DollarSign,
  MoreHorizontal,
  Eye,
  Pencil,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { formatEnumLabel } from '@/lib/enum-label';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/feedback/EmptyState';
import { OrgUnitDeleteDialog } from '@/components/library/org-units/OrgUnitDeleteDialog';

import { orgUnitKeys } from '@/lib/query-keys';
import { useEntityNotes } from '@/hooks/useEntityNotes';
import { getOrgUnits, deleteOrgUnit } from '@/lib/org-units';
import { resolveOrgUnitCreateOutcome, resolveOrgUnitUpdateOutcome } from '@/lib/mutation-outcome/org-unit';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { EntityGraphSyncRecoveryBanner } from '@/components/library/shared/EntityGraphSyncRecoveryBanner';
import { getRelationsForEntity, createRelation, deleteRelation } from '@/lib/relations';
import { buildTargetSnapshot } from '@/lib/relation-snapshot';
import type {
  OrgUnit,
  OrgUnitType,
  OrgUnitLevel,
  CreateOrgUnitInput,
  Relation,
  EntityType,
  RelationType,
  EntitySnapshot,
} from '@/lib/types';
import { OrgUnitSheet } from '@/components/sheets/OrgUnitSheet';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useControlledSheet } from '@/hooks/useSheetUrl';
import { createLogger } from '@/lib/logger';
import {
  deleteEntitiesWithExactOutcomes,
  orderOrgUnitDeletionIds,
} from '@/lib/entity-delete-outcomes';

const log = createLogger('org-units-page');

// Leading chip icon — canon color/glyph for the orgUnit entity type (CONV-CHIP).
const ChipIcon = entityIcon('orgUnit');

// ============================================================================
// CONSTANTS
// ============================================================================

const ORG_UNIT_TYPES: { value: OrgUnitType; label: string }[] = [
  { value: 'business_unit', label: 'Business Unit' },
  { value: 'department', label: 'Department' },
  { value: 'team', label: 'Team' },
  { value: 'division', label: 'Division' },
  { value: 'region', label: 'Region' },
  { value: 'subsidiary', label: 'Subsidiary' },
];

const ORG_UNIT_LEVELS: { value: OrgUnitLevel; label: string }[] = [
  { value: 1, label: 'Level 1 (Top)' },
  { value: 2, label: 'Level 2' },
  { value: 3, label: 'Level 3' },
  { value: 4, label: 'Level 4' },
  { value: 5, label: 'Level 5' },
];

type ViewMode = 'table' | 'grid';
type SortField = 'name' | 'level' | 'type' | 'employeeCount' | 'updatedAt';
type SortDirection = 'asc' | 'desc';

// ============================================================================
// TYPE BADGE COLORS
// ============================================================================

function formatTypeName(type: OrgUnitType): string {
  const names: Record<OrgUnitType, string> = {
    business_unit: 'Business Unit',
    department: 'Department',
    team: 'Team',
    division: 'Division',
    region: 'Region',
    subsidiary: 'Subsidiary',
  };
  return names[type] || formatEnumLabel(type);
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

function formatNumber(num: number | undefined): string {
  if (num === undefined || num === null) return '—';
  return new Intl.NumberFormat('en-US').format(num);
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
              <Skeleton className="h-4 w-20" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-14" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-20" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
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
                <Skeleton className="h-6 w-24 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-12" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
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
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-28" />
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
  currentSort: { key: SortField; direction: SortDirection };
  onSort: (key: SortField) => void;
  className?: string;
}

function SortableHeader({ label, sortKey, currentSort, onSort, className }: SortableHeaderProps) {
  const isActive = currentSort.key === sortKey;
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
  itemLabel = 'org units',
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

export default function OrgUnitsPage() {
  const graphSync = useLibraryEntityGraphSync<OrgUnit>({
    entityType: 'orgUnit',
    entityTypeLabel: 'org unit',
    getName: (orgUnit) => orgUnit.name,
  });
  const queryClient = useQueryClient();

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<OrgUnitType[]>([]);
  const [selectedLevels, setSelectedLevels] = useState<OrgUnitLevel[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: SortField; direction: SortDirection }>({
    key: 'level',
    direction: 'asc',
  });

  // Pagination (0-indexed)
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sheet state — edit mode is URL-controlled (`?orgunit=<id>`, see below);
  // the create flow has no entity id to put in the URL, so it stays local.
  const [isCreating, setIsCreating] = useState(false);

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [orgUnitToDelete, setOrgUnitToDelete] = useState<OrgUnit | null>(null);

  // Relations for the selected org unit (UX-032), keyed by org unit id.
  const [orgUnitRelations, setOrgUnitRelations] = useState<Record<string, Relation[]>>({});

  // Fetch org units
  const {
    data: orgUnits = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: orgUnitKeys.all,
    queryFn: getOrgUnits,
  });

  const orgUnitToDeleteChildCount = useMemo(
    () =>
      orgUnitToDelete
        ? orgUnits.filter((orgUnit) => orgUnit.parentId === orgUnitToDelete.id).length
        : 0,
    [orgUnitToDelete, orgUnits]
  );

  // Listen for data refresh events from AI Assistant
  useDataRefresh(['orgUnits', 'relations'], () => {
    log.info('Auto-refreshing data after AI Assistant action');
    queryClient.invalidateQueries({ queryKey: orgUnitKeys.all });
  });

  // URL-controlled edit sheet. Param name must stay in sync with
  // ENTITY_SHEET_PARAMS in entity-links.ts so graph / command-palette deep
  // links open the sheet directly.
  const {
    selectedEntity: editingOrgUnit,
    isOpen: isSheetOpenFromUrl,
    open: openOrgUnitSheet,
    close: closeOrgUnitSheet,
  } = useControlledSheet({
    entities: orgUnits,
    getId: (unit) => unit.id,
    paramName: 'orgunit',
  });

  const editingOrgUnitChildCount = useMemo(
    () =>
      editingOrgUnit
        ? orgUnits.filter((orgUnit) => orgUnit.parentId === editingOrgUnit.id).length
        : 0,
    [editingOrgUnit, orgUnits]
  );

  const sheetOpen = isCreating || (isSheetOpenFromUrl && !!editingOrgUnit);

  // Notes for the selected org unit (UX-024) — shared entity-notes contract.
  const {
    notes: orgUnitNotes,
    onAddNote: onAddOrgUnitNote,
    onUpdateNote: onUpdateOrgUnitNote,
    onDeleteNote: onDeleteOrgUnitNote,
  } = useEntityNotes('org-units', editingOrgUnit?.id);

  // Load relations for the selected org unit (UX-032).
  useEffect(() => {
    if (!editingOrgUnit) return;
    const orgUnitId = editingOrgUnit.id;
    getRelationsForEntity(orgUnitId)
      .then((relations) => {
        setOrgUnitRelations((prev) => ({ ...prev, [orgUnitId]: relations }));
      })
      .catch((error) => {
        log.error('Failed to load org unit relations', error instanceof Error ? error : new Error(String(error)), {
          orgUnitId,
        });
      });
  }, [editingOrgUnit?.id]);

  const handleAddRelation = useCallback(
    async (targetId: string, targetType: EntityType, relationType: RelationType) => {
      if (!editingOrgUnit) return;
      try {
        const sourceSnapshot: EntitySnapshot = {
          type: 'orgUnit',
          id: editingOrgUnit.id,
          name: editingOrgUnit.name,
          description: editingOrgUnit.description,
          snapshotAt: Date.now(),
        };

        // Resolve the canonical target snapshot with the real name; a missing
        // target is a visible failure, not a silent empty-name write.
        const targetSnapshot = await buildTargetSnapshot(targetId, targetType);
        if (!targetSnapshot) {
          toast.error('Could not find the entity to link');
          return;
        }

        await createRelation({ relationType, sourceSnapshot, targetSnapshot });

        const updatedRelations = await getRelationsForEntity(editingOrgUnit.id);
        setOrgUnitRelations((prev) => ({ ...prev, [editingOrgUnit.id]: updatedRelations }));
        toast.success('Relation added');
      } catch (error) {
        log.error('Failed to add relation', error instanceof Error ? error : new Error(String(error)));
        toast.error('Failed to add relation');
      }
    },
    [editingOrgUnit]
  );

  const handleRemoveRelation = useCallback(
    async (relationId: string) => {
      try {
        await deleteRelation(relationId);
        if (editingOrgUnit) {
          const updatedRelations = await getRelationsForEntity(editingOrgUnit.id);
          setOrgUnitRelations((prev) => ({ ...prev, [editingOrgUnit.id]: updatedRelations }));
        }
        toast.success('Relation removed');
      } catch (error) {
        log.error('Failed to remove relation', error instanceof Error ? error : new Error(String(error)));
        toast.error('Failed to remove relation');
      }
    },
    [editingOrgUnit]
  );

  /** Back-compat setter for the sheet's onOpenChange: close tears down both modes. */
  const setSheetOpen = useCallback(
    (open: boolean) => {
      if (open) {
        // Edit opens go through handleEdit with a target entity; an
        // untargeted `true` can only mean the create sheet.
        setIsCreating(true);
      } else {
        setIsCreating(false);
        closeOrgUnitSheet();
      }
    },
    [closeOrgUnitSheet]
  );

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteOrgUnit,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgUnitKeys.all });
      toast.success('Org unit deleted');
      setDeleteDialogOpen(false);
      setOrgUnitToDelete(null);
    },
    onError: (err) => {
      toast.error('Failed to delete org unit', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });

  // Bulk delete mutation
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const orderedIds = orderOrgUnitDeletionIds(ids, orgUnits);
      return deleteEntitiesWithExactOutcomes(orderedIds, deleteOrgUnit, 1);
    },
    onSuccess: ({ deletedIds, failed }) => {
      setSelectedIds(new Set(failed.map(({ id }) => id)));
      if (deletedIds.length > 0) {
        toast.success(`${deletedIds.length} org unit${deletedIds.length === 1 ? '' : 's'} deleted`);
      }
      if (failed.length > 0) {
        const firstError = failed[0]?.error;
        toast.error(`${failed.length} org unit${failed.length === 1 ? '' : 's'} not deleted`, {
          description: firstError instanceof Error ? firstError.message : 'Retry after resolving dependencies.',
        });
      }
    },
    onError: (err) => {
      toast.error('Failed to delete org units', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orgUnitKeys.all });
    },
  });

  // Save handler for OrgUnitSheet
  const handleSave = useCallback(
    async (data: {
      name: string;
      description?: string;
      type: OrgUnitType;
      parentId?: string;
      level: OrgUnitLevel;
      headUserId?: string;
      headName?: string;
      employeeCount?: number;
      annualBudget?: number;
      location?: string;
      tags: string[];
    }) => {
      // Convert "none" to undefined for parentId (Firestore doesn't accept "none" as a valid parent)
      const cleanedData = {
        ...data,
        parentId: data.parentId === 'none' ? undefined : data.parentId,
      };

      // GRAPH-058: a committed write whose graph handoff was lost is reported as
      // saved-locally with a retry, never as a failed save.
      if (editingOrgUnit) {
        // Update existing
        const outcome = await resolveOrgUnitUpdateOutcome(editingOrgUnit, cleanedData);
        const status = graphSync.applyOutcome(outcome, { applyCommitted: () => undefined, success: null });
        if (status === 'saved-and-queued') toast.success('Org unit updated');
      } else {
        // Create new
        const createData: CreateOrgUnitInput = {
          ...cleanedData,
          tags: cleanedData.tags || [],
        };
        const outcome = await resolveOrgUnitCreateOutcome(createData);
        const status = graphSync.applyOutcome(outcome, { applyCommitted: () => undefined, success: null });
        if (status === 'saved-and-queued') toast.success('Org unit created');
      }
      queryClient.invalidateQueries({ queryKey: orgUnitKeys.all });
      setSheetOpen(false);
    },
    [editingOrgUnit, queryClient, setSheetOpen, graphSync]
  );

  // Filter and sort org units
  const filteredOrgUnits = useMemo(() => {
    let result = [...orgUnits];

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (unit) =>
          unit.name.toLowerCase().includes(query) ||
          unit.description?.toLowerCase().includes(query) ||
          unit.location?.toLowerCase().includes(query)
      );
    }

    // Apply type filter
    if (selectedTypes.length > 0) {
      result = result.filter((unit) => selectedTypes.includes(unit.type));
    }

    // Apply level filter
    if (selectedLevels.length > 0) {
      result = result.filter((unit) => selectedLevels.includes(unit.level));
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;

      switch (sortConfig.key) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'level':
          comparison = a.level - b.level;
          break;
        case 'type':
          comparison = a.type.localeCompare(b.type);
          break;
        case 'employeeCount':
          comparison = (a.employeeCount || 0) - (b.employeeCount || 0);
          break;
        case 'updatedAt':
          comparison = a.updatedAt - b.updatedAt;
          break;
      }

      return sortConfig.direction === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [orgUnits, searchQuery, selectedTypes, selectedLevels, sortConfig]);

  // Paginate
  const paginatedOrgUnits = useMemo(() => {
    const start = pageIndex * pageSize;
    return filteredOrgUnits.slice(start, start + pageSize);
  }, [filteredOrgUnits, pageIndex, pageSize]);

  // Handlers
  const handleCreateNew = useCallback(() => {
    closeOrgUnitSheet();
    setIsCreating(true);
  }, [closeOrgUnitSheet]);

  const handleEdit = useCallback(
    (orgUnit: OrgUnit) => {
      setIsCreating(false);
      openOrgUnitSheet(orgUnit);
    },
    [openOrgUnitSheet]
  );

  const handleDelete = useCallback((orgUnit: OrgUnit) => {
    setOrgUnitToDelete(orgUnit);
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (orgUnitToDelete) {
      deleteMutation.mutate(orgUnitToDelete.id);
    }
  }, [orgUnitToDelete, deleteMutation]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size > 0) {
      bulkDeleteMutation.mutate(Array.from(selectedIds));
    }
  }, [selectedIds, bulkDeleteMutation]);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === paginatedOrgUnits.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedOrgUnits.map((u) => u.id)));
    }
  }, [paginatedOrgUnits, selectedIds.size]);

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

  const toggleSort = useCallback((field: SortField) => {
    setSortConfig((prev) => ({
      key: field,
      direction: prev.key === field && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setSelectedTypes([]);
    setSelectedLevels([]);
    setPageIndex(0);
  }, []);

  // Reset page when filters change
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setPageIndex(0);
  }, []);

  const toggleTypeFilter = useCallback((type: OrgUnitType) => {
    setSelectedTypes((prev) => {
      const next = prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type];
      return next;
    });
    setPageIndex(0);
  }, []);

  const toggleLevelFilter = useCallback((level: OrgUnitLevel) => {
    setSelectedLevels((prev) => {
      const next = prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level];
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
              icon={Building2}
              title="Failed to load org units"
              description={error instanceof Error ? error.message : 'Unknown error occurred'}
              action={{
                label: 'Try Again',
                onClick: () => queryClient.invalidateQueries({ queryKey: orgUnitKeys.all }),
              }}
            />
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  const hasFilters = searchQuery || selectedTypes.length > 0 || selectedLevels.length > 0;

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding>
          {/* Header Row: Title + Filters + Actions */}
          <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
            {/* Left: Title */}
            <div className="space-y-1 shrink-0">
              <h1 className="text-2xl font-semibold tracking-tight">Org Units</h1>
              <p className="text-sm text-muted-foreground">
                Organizational structure: business units, departments, and teams.
              </p>
            </div>

            {/* Right: Search, Filters, Actions */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search org units..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-10 h-9 w-full sm:w-[200px]"
                />
              </div>

              {/* Type Filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2">
                    Type
                    {selectedTypes.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {selectedTypes.length}
                      </Badge>
                    )}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {ORG_UNIT_TYPES.map((type) => (
                    <DropdownMenuItem key={type.value} onClick={() => toggleTypeFilter(type.value)} className="gap-2">
                      <Checkbox checked={selectedTypes.includes(type.value)} className="pointer-events-none" />
                      {type.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Level Filter */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-2">
                    Level
                    {selectedLevels.length > 0 && (
                      <Badge variant="secondary" className="ml-1">
                        {selectedLevels.length}
                      </Badge>
                    )}
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  {ORG_UNIT_LEVELS.map((level) => (
                    <DropdownMenuItem
                      key={level.value}
                      onClick={() => toggleLevelFilter(level.value)}
                      className="gap-2"
                    >
                      <Checkbox checked={selectedLevels.includes(level.value)} className="pointer-events-none" />
                      {level.label}
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

          <EntityGraphSyncRecoveryBanner
            recoveries={graphSync.recoveries}
            maxRetryAttempts={graphSync.maxRetryAttempts}
            entityTypeLabel={graphSync.entityTypeLabel}
            getLabel={graphSync.getRecoveryLabel}
            onRetry={graphSync.retryGraphSync}
          />

          {/* Content Area */}
          {isLoading ? (
            viewMode === 'table' ? (
              <div className="p-4 space-y-2">
                <TableSkeleton />
              </div>
            ) : (
              <div className="p-4">
                <GridSkeleton />
              </div>
            )
          ) : filteredOrgUnits.length === 0 ? (
            <EmptyState
              icon={Building2}
              title={hasFilters ? 'No org units match your filters' : 'No org units yet'}
              description={
                hasFilters
                  ? 'Try adjusting your search or filters'
                  : 'Create your first org unit to start building your organizational structure'
              }
              action={
                hasFilters
                  ? { label: 'Clear Filters', onClick: clearFilters }
                  : { label: 'New org unit', onClick: handleCreateNew }
              }
            />
          ) : viewMode === 'table' ? (
            <>
              <div className="relative overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow className="hover:bg-transparent border-b border-border">
                      <TableHead className="w-[50px] px-4 py-3">
                        <Checkbox
                          checked={paginatedOrgUnits.length > 0 && selectedIds.size === paginatedOrgUnits.length}
                          onCheckedChange={handleSelectAll}
                        />
                      </TableHead>
                      <TableHead className="px-4 py-3">
                        <SortableHeader label="Name" sortKey="name" currentSort={sortConfig} onSort={toggleSort} />
                      </TableHead>
                      <TableHead className="hidden sm:table-cell px-4 py-3">
                        <SortableHeader label="Type" sortKey="type" currentSort={sortConfig} onSort={toggleSort} />
                      </TableHead>
                      <TableHead className="hidden md:table-cell px-4 py-3">
                        <SortableHeader label="Level" sortKey="level" currentSort={sortConfig} onSort={toggleSort} />
                      </TableHead>
                      <TableHead className="hidden lg:table-cell px-4 py-3">
                        <SortableHeader
                          label="Employees"
                          sortKey="employeeCount"
                          currentSort={sortConfig}
                          onSort={toggleSort}
                        />
                      </TableHead>
                      <TableHead className="hidden lg:table-cell px-4 py-3 font-medium text-muted-foreground">
                        Budget
                      </TableHead>
                      <TableHead className="hidden xl:table-cell px-4 py-3 font-medium text-muted-foreground">
                        Location
                      </TableHead>
                      <TableHead className="w-[50px] px-4 py-3" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedOrgUnits.map((orgUnit) => (
                      <TableRow
                        key={orgUnit.id}
                        className={cn(
                          'cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
                          selectedIds.has(orgUnit.id) && 'bg-accent/20'
                        )}
                        onClick={() => handleEdit(orgUnit)}
                      >
                        <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedIds.has(orgUnit.id)}
                            onCheckedChange={() => handleSelectOne(orgUnit.id)}
                          />
                        </TableCell>
                        <TableCell className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn(
                                'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                                ENTITY_COLORS.orgUnit.bg
                              )}
                            >
                              <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.orgUnit.text)} />
                            </div>
                            <div className="min-w-0 space-y-0.5">
                              <div className="font-medium leading-none truncate hover:underline" title={orgUnit.name}>
                                {orgUnit.name}
                              </div>
                              {orgUnit.description && (
                                <div
                                  className="text-xs text-muted-foreground truncate max-w-[220px]"
                                  title={orgUnit.description}
                                >
                                  {orgUnit.description}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell px-4 py-3">
                          <Badge variant="outline" className="text-xs font-normal px-2 py-0.5 whitespace-nowrap">
                            {formatTypeName(orgUnit.type)}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell px-4 py-3">
                          <Badge variant="outline" className="text-xs font-normal px-2 py-0.5">
                            L{orgUnit.level}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell px-4 py-3">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <Users className="h-3 w-3" />
                            {formatNumber(orgUnit.employeeCount)}
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell px-4 py-3">
                          <span className="text-muted-foreground">{formatCurrency(orgUnit.annualBudget)}</span>
                        </TableCell>
                        <TableCell className="hidden xl:table-cell px-4 py-3">
                          {orgUnit.location ? (
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <MapPin className="h-3 w-3" />
                              {orgUnit.location}
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
                              <DropdownMenuItem onClick={() => handleEdit(orgUnit)}>
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleEdit(orgUnit)}>
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleDelete(orgUnit)}
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

              <DataPagination
                pageIndex={pageIndex}
                pageSize={pageSize}
                totalCount={filteredOrgUnits.length}
                onPageChange={setPageIndex}
                onPageSizeChange={setPageSize}
                itemLabel="org units"
              />
            </>
          ) : (
            <>
              {/* Grid View */}
              <div className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {paginatedOrgUnits.map((orgUnit) => (
                    <Card
                      key={orgUnit.id}
                      className="cursor-pointer hover:border-primary transition-colors"
                      onClick={() => handleEdit(orgUnit)}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start gap-3">
                          <div
                            className={cn(
                              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                              ENTITY_COLORS.orgUnit.bg
                            )}
                          >
                            <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.orgUnit.text)} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between">
                              <CardTitle className="text-lg truncate">{orgUnit.name}</CardTitle>
                              <Checkbox
                                checked={selectedIds.has(orgUnit.id)}
                                onCheckedChange={() => handleSelectOne(orgUnit.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs font-normal px-2 py-0.5 whitespace-nowrap">
                                {formatTypeName(orgUnit.type)}
                              </Badge>
                              <Badge variant="outline" className="text-xs font-normal px-2 py-0.5">
                                L{orgUnit.level}
                              </Badge>
                            </div>
                          </div>
                        </div>
                        {orgUnit.description && (
                          <CardDescription className="line-clamp-2 mt-2">{orgUnit.description}</CardDescription>
                        )}
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Users className="h-4 w-4" />
                            <span>{formatNumber(orgUnit.employeeCount)} employees</span>
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <DollarSign className="h-4 w-4" />
                            <span>{formatCurrency(orgUnit.annualBudget)}</span>
                          </div>
                          {orgUnit.location && (
                            <div className="flex items-center gap-2 text-muted-foreground col-span-2">
                              <MapPin className="h-4 w-4" />
                              <span>{orgUnit.location}</span>
                            </div>
                          )}
                        </div>
                        {orgUnit.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-3">
                            {orgUnit.tags.slice(0, 3).map((tag) => (
                              <Badge key={tag} variant="outline" className="text-xs font-normal px-1.5 py-0 h-5">
                                {tag}
                              </Badge>
                            ))}
                            {orgUnit.tags.length > 3 && (
                              <Badge variant="outline" className="text-xs font-normal px-1.5 py-0 h-5">
                                +{orgUnit.tags.length - 3}
                              </Badge>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>

              <DataPagination
                pageIndex={pageIndex}
                pageSize={pageSize}
                totalCount={filteredOrgUnits.length}
                onPageChange={setPageIndex}
                onPageSizeChange={setPageSize}
                itemLabel="org units"
              />
            </>
          )}

          {/* Org Unit Sheet */}
          <OrgUnitSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            orgUnit={editingOrgUnit}
            onSave={handleSave}
            onDelete={
              editingOrgUnit
                ? async () => {
                    try {
                      await deleteOrgUnit(editingOrgUnit.id);
                      toast.success('Org unit deleted');
                      queryClient.invalidateQueries({ queryKey: orgUnitKeys.all });
                    } catch (error) {
                      toast.error('Failed to delete org unit', {
                        description: error instanceof Error ? error.message : 'Unknown error',
                      });
                      throw error;
                    }
                  }
                : undefined
            }
            deleteChildCount={editingOrgUnitChildCount}
            parentOptions={orgUnits
              .filter((u) => u.id !== editingOrgUnit?.id && u.level < 5)
              .map((u) => ({ id: u.id, name: u.name, level: u.level }))}
            relations={editingOrgUnit ? orgUnitRelations[editingOrgUnit.id] || [] : []}
            onAddRelation={handleAddRelation}
            onRemoveRelation={handleRemoveRelation}
            notes={orgUnitNotes}
            onAddNote={onAddOrgUnitNote}
            onUpdateNote={onUpdateOrgUnitNote}
            onDeleteNote={onDeleteOrgUnitNote}
          />

          <OrgUnitDeleteDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            orgUnitName={orgUnitToDelete?.name}
            childCount={orgUnitToDeleteChildCount}
            isPending={deleteMutation.isPending}
            onConfirm={handleConfirmDelete}
          />
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
