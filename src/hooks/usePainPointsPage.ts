'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { createLogger } from '@/lib/logger';
import { painPointKeys, orgUnitKeys } from '@/lib/query-keys';

const log = createLogger('hooks/usePainPointsPage');
import { getPainPoints, deletePainPoint } from '@/lib/pain-points';
import { resolvePainPointCreateOutcome, resolvePainPointUpdateOutcome } from '@/lib/mutation-outcome/pain-point';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { getOrgUnits } from '@/lib/org-units';
import { getRelationsForEntity, createRelation, deleteRelation } from '@/lib/relations';
import { buildTargetSnapshot } from '@/lib/relation-snapshot';
import type {
  PainPoint,
  PainPointSeverity,
  PainPointStatus,
  PainPointCategory,
  CreatePainPointInput,
  EntityType,
  RelationType,
  EntitySnapshot,
  Relation,
} from '@/lib/types';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useControlledSheet } from '@/hooks/useSheetUrl';
import type { SortConfig } from '@/components/library/shared/types';
import { deleteEntitiesWithExactOutcomes } from '@/lib/entity-delete-outcomes';

// ============================================================================
// TYPES
// ============================================================================

export type PainPointSortField = 'title' | 'severity' | 'status' | 'category' | 'estimatedImpact' | 'updatedAt';
type ViewMode = 'table' | 'grid';

// ============================================================================
// CONSTANTS
// ============================================================================

export const PAIN_POINT_SEVERITIES: { value: PainPointSeverity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export const PAIN_POINT_STATUSES: { value: PainPointStatus; label: string }[] = [
  { value: 'identified', label: 'Identified' },
  { value: 'validated', label: 'Validated' },
  { value: 'being_addressed', label: 'Being Addressed' },
  { value: 'resolved', label: 'Resolved' },
];

export const PAIN_POINT_CATEGORIES: { value: PainPointCategory; label: string }[] = [
  { value: 'operational', label: 'Operational' },
  { value: 'customer', label: 'Customer' },
  { value: 'regulatory', label: 'Regulatory' },
  { value: 'technical', label: 'Technical' },
  { value: 'market', label: 'Market' },
  { value: 'financial', label: 'Financial' },
  { value: 'talent', label: 'Talent' },
  { value: 'other', label: 'Other' },
];

// ============================================================================
// SORT ORDERING
// ============================================================================

const severityOrder: Record<PainPointSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const statusOrder: Record<PainPointStatus, number> = {
  identified: 0,
  validated: 1,
  being_addressed: 2,
  resolved: 3,
};

// ============================================================================
// HOOK
// ============================================================================

export function usePainPointsPage() {
  const graphSync = useLibraryEntityGraphSync<PainPoint>({
    entityType: 'painPoint',
    entityTypeLabel: 'pain point',
    getName: (painPoint) => painPoint.title,
  });
  const queryClient = useQueryClient();

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSeverities, setSelectedSeverities] = useState<PainPointSeverity[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<PainPointStatus[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<PainPointCategory[]>([]);
  const [sortConfig, setSortConfig] = useState<SortConfig | null>({
    key: 'severity',
    direction: 'asc',
  });

  // Pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sheet state — edit mode is URL-controlled (`?painpoint=<id>`, see below);
  // the create flow has no entity id to put in the URL, so it stays local.
  const [isCreating, setIsCreating] = useState(false);

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [painPointToDelete, setPainPointToDelete] = useState<PainPoint | null>(null);

  // Relations state for the sheet
  const [painPointRelations, setPainPointRelations] = useState<Record<string, Relation[]>>({});

  // Fetch org units
  const { data: orgUnits = [] } = useQuery({
    queryKey: orgUnitKeys.all,
    queryFn: getOrgUnits,
  });

  // Fetch pain points
  const {
    data: painPoints = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: painPointKeys.all,
    queryFn: getPainPoints,
  });

  // Listen for data refresh events from AI Assistant
  useDataRefresh(['painPoints', 'relations'], () => {
    queryClient.invalidateQueries({ queryKey: painPointKeys.all });
  });

  // URL-controlled edit sheet. Param name must stay in sync with
  // ENTITY_SHEET_PARAMS in entity-links.ts so graph / command-palette deep
  // links open the sheet directly.
  const {
    selectedEntity: editingPainPoint,
    isOpen: isSheetOpenFromUrl,
    open: openPainPointSheet,
    close: closePainPointSheet,
  } = useControlledSheet({
    entities: painPoints,
    getId: (pp) => pp.id,
    paramName: 'painpoint',
  });

  const sheetOpen = isCreating || (isSheetOpenFromUrl && !!editingPainPoint);

  /** Back-compat setter for the page component: close tears down both modes. */
  const setSheetOpen = useCallback(
    (open: boolean) => {
      if (open) {
        // Edit opens go through handleEdit with a target entity; an
        // untargeted `true` can only mean the create sheet.
        setIsCreating(true);
      } else {
        setIsCreating(false);
        closePainPointSheet();
      }
    },
    [closePainPointSheet]
  );

  // Load relations whenever the edited pain point changes — covers both
  // row-click opens and URL deep links (which never pass through handleEdit).
  useEffect(() => {
    if (!editingPainPoint) return;
    const painPointId = editingPainPoint.id;
    let cancelled = false;
    getRelationsForEntity(painPointId)
      .then((relations) => {
        if (cancelled) return;
        setPainPointRelations((prev) => ({ ...prev, [painPointId]: relations }));
      })
      .catch((error) => {
        log.error('Failed to fetch relations', error instanceof Error ? error : new Error(String(error)), {
          painPointId,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [editingPainPoint?.id]);

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deletePainPoint,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: painPointKeys.all });
      toast.success('Pain point deleted');
      setDeleteDialogOpen(false);
      setPainPointToDelete(null);
    },
    onError: (err) => {
      toast.error('Failed to delete pain point', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });

  // Bulk delete mutation
  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => deleteEntitiesWithExactOutcomes(ids, deletePainPoint),
    onSuccess: ({ deletedIds, failed }) => {
      setSelectedIds(new Set(failed.map(({ id }) => id)));
      if (deletedIds.length > 0) {
        toast.success(`${deletedIds.length} pain point${deletedIds.length === 1 ? '' : 's'} deleted`);
      }
      if (failed.length > 0) {
        const firstError = failed[0]?.error;
        toast.error(`${failed.length} pain point${failed.length === 1 ? '' : 's'} not deleted`, {
          description: firstError instanceof Error ? firstError.message : 'Retry after resolving dependencies.',
        });
      }
    },
    onError: (err) => {
      toast.error('Failed to delete pain points', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: painPointKeys.all });
    },
  });

  // Save handler for PainPointSheet
  const handleSave = useCallback(
    async (data: {
      title: string;
      description: string;
      severity: string;
      category: string;
      status: string;
      affectedOrgUnitIds: string[];
      estimatedImpact?: number;
      actualImpact?: number;
      impactDescription?: string;
      rootCauses: string[];
      tags: string[];
    }) => {
      const painPointData = {
        title: data.title,
        description: data.description,
        severity: data.severity as PainPointSeverity,
        category: data.category as PainPointCategory,
        status: data.status as PainPointStatus,
        affectedOrgUnitIds: data.affectedOrgUnitIds,
        estimatedImpact: data.estimatedImpact,
        actualImpact: data.actualImpact,
        impactDescription: data.impactDescription,
        rootCauses: data.rootCauses || [],
        tags: data.tags || [],
      };

      // GRAPH-058: a committed write whose graph handoff was lost is reported as
      // saved-locally with a retry, never as a failed save. The shared hook owns
      // the saved-locally toast, so the success branch keeps this page's sonner
      // confirmation and nothing double-reports.
      if (editingPainPoint) {
        const outcome = await resolvePainPointUpdateOutcome(editingPainPoint, painPointData);
        const status = graphSync.applyOutcome(outcome, {
          applyCommitted: () => undefined,
          success: null,
        });
        if (status === 'saved-and-queued') toast.success('Pain point updated');
      } else {
        const createData: CreatePainPointInput = {
          ...painPointData,
          linkedPrototypeIds: [],
          linkedTechnologyIds: [],
          linkedInitiativeIds: [],
        };
        const outcome = await resolvePainPointCreateOutcome(createData);
        const status = graphSync.applyOutcome(outcome, {
          applyCommitted: () => undefined,
          success: null,
        });
        if (status === 'saved-and-queued') toast.success('Pain point created');
      }
      queryClient.invalidateQueries({ queryKey: painPointKeys.all });
      setSheetOpen(false);
    },
    [editingPainPoint, queryClient, setSheetOpen, graphSync]
  );

  // Filter pain points
  const filteredPainPoints = useMemo(() => {
    let result = [...painPoints];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (pp) =>
          pp.title.toLowerCase().includes(query) ||
          pp.description?.toLowerCase().includes(query) ||
          pp.impactDescription?.toLowerCase().includes(query)
      );
    }

    if (selectedSeverities.length > 0) {
      result = result.filter((pp) => selectedSeverities.includes(pp.severity));
    }

    if (selectedStatuses.length > 0) {
      result = result.filter((pp) => selectedStatuses.includes(pp.status));
    }

    if (selectedCategories.length > 0) {
      result = result.filter((pp) => selectedCategories.includes(pp.category));
    }

    return result;
  }, [painPoints, searchQuery, selectedSeverities, selectedStatuses, selectedCategories]);

  // Sort pain points
  const sortedPainPoints = useMemo(() => {
    if (!sortConfig) return filteredPainPoints;

    return [...filteredPainPoints].sort((a, b) => {
      let comparison = 0;

      switch (sortConfig.key) {
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'severity':
          comparison = severityOrder[a.severity] - severityOrder[b.severity];
          break;
        case 'status':
          comparison = statusOrder[a.status] - statusOrder[b.status];
          break;
        case 'category':
          comparison = a.category.localeCompare(b.category);
          break;
        case 'estimatedImpact':
          comparison = (a.estimatedImpact || 0) - (b.estimatedImpact || 0);
          break;
        case 'updatedAt':
          comparison = a.updatedAt - b.updatedAt;
          break;
      }

      return sortConfig.direction === 'desc' ? -comparison : comparison;
    });
  }, [filteredPainPoints, sortConfig]);

  // Paginate
  const paginatedPainPoints = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedPainPoints.slice(start, start + pageSize);
  }, [sortedPainPoints, pageIndex, pageSize]);

  // Handlers
  const handleCreateNew = useCallback(() => {
    closePainPointSheet();
    setIsCreating(true);
  }, [closePainPointSheet]);

  // Relations load via the editingPainPoint effect above.
  const handleEdit = useCallback(
    (painPoint: PainPoint) => {
      setIsCreating(false);
      openPainPointSheet(painPoint);
    },
    [openPainPointSheet]
  );

  const handleDeleteClick = useCallback((painPoint: PainPoint) => {
    setPainPointToDelete(painPoint);
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (painPointToDelete) {
      deleteMutation.mutate(painPointToDelete.id);
    }
  }, [painPointToDelete, deleteMutation]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size > 0) {
      bulkDeleteMutation.mutate(Array.from(selectedIds));
    }
  }, [selectedIds, bulkDeleteMutation]);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === paginatedPainPoints.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedPainPoints.map((pp) => pp.id)));
    }
  }, [paginatedPainPoints, selectedIds.size]);

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

  const handleSort = useCallback((key: string) => {
    setSortConfig((current) => {
      if (current?.key === key) {
        if (current.direction === 'asc') {
          return { key, direction: 'desc' };
        } else {
          return null;
        }
      }
      return { key, direction: 'asc' };
    });
  }, []);

  // Relation handlers
  const handleAddRelation = useCallback(
    async (targetId: string, targetType: EntityType, relationType: RelationType) => {
      if (!editingPainPoint) return;

      try {
        const sourceSnapshot: EntitySnapshot = {
          type: 'painPoint',
          id: editingPainPoint.id,
          name: editingPainPoint.title,
          description: editingPainPoint.description,
          status: editingPainPoint.status,
          snapshotAt: Date.now(),
        };

        // Resolve the canonical target snapshot with the real name. createRelation
        // stores it verbatim, so an empty name would persist, break the relation
        // card render, and make UI unlink impossible (UX-035). A missing target
        // is a visible failure, not a silent write.
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

        const updatedRelations = await getRelationsForEntity(editingPainPoint.id);
        setPainPointRelations((prev) => ({
          ...prev,
          [editingPainPoint.id]: updatedRelations,
        }));

        toast.success('Relation added');
      } catch (error) {
        log.error('Failed to add relation', error instanceof Error ? error : new Error(String(error)));
        toast.error('Failed to add relation');
      }
    },
    [editingPainPoint]
  );

  const handleRemoveRelation = useCallback(
    async (relationId: string) => {
      try {
        await deleteRelation(relationId);

        if (editingPainPoint) {
          const updatedRelations = await getRelationsForEntity(editingPainPoint.id);
          setPainPointRelations((prev) => ({
            ...prev,
            [editingPainPoint.id]: updatedRelations,
          }));
        }

        toast.success('Relation removed');
      } catch (error) {
        log.error('Failed to remove relation', error instanceof Error ? error : new Error(String(error)));
        toast.error('Failed to remove relation');
      }
    },
    [editingPainPoint]
  );

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setSelectedSeverities([]);
    setSelectedStatuses([]);
    setSelectedCategories([]);
    setPageIndex(0);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setPageIndex(0);
  }, []);

  const toggleSeverityFilter = useCallback((severity: PainPointSeverity) => {
    setSelectedSeverities((prev) =>
      prev.includes(severity) ? prev.filter((s) => s !== severity) : [...prev, severity]
    );
    setPageIndex(0);
  }, []);

  const toggleStatusFilter = useCallback((status: PainPointStatus) => {
    setSelectedStatuses((prev) => (prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]));
    setPageIndex(0);
  }, []);

  const toggleCategoryFilter = useCallback((category: PainPointCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
    setPageIndex(0);
  }, []);

  const handleSheetDelete = editingPainPoint
    ? async () => {
        await deletePainPoint(editingPainPoint.id);
        toast.success('Pain point deleted');
        queryClient.invalidateQueries({ queryKey: painPointKeys.all });
        setSheetOpen(false);
      }
    : undefined;

  const hasFilters =
    searchQuery || selectedSeverities.length > 0 || selectedStatuses.length > 0 || selectedCategories.length > 0;

  return {
    // GRAPH-058 saved-locally recovery
    graphSyncRecoveries: graphSync.recoveries,
    maxGraphSyncRetries: graphSync.maxRetryAttempts,
    graphSyncEntityTypeLabel: graphSync.entityTypeLabel,
    getGraphSyncRecoveryLabel: graphSync.getRecoveryLabel,
    retryGraphSync: graphSync.retryGraphSync,
    // Data
    painPoints,
    sortedPainPoints,
    paginatedPainPoints,
    orgUnits,
    isLoading,
    error,

    // View state
    viewMode,
    setViewMode,
    searchQuery,
    handleSearchChange,
    sortConfig,
    handleSort,
    hasFilters,
    clearFilters,

    // Filters
    selectedSeverities,
    selectedStatuses,
    selectedCategories,
    toggleSeverityFilter,
    toggleStatusFilter,
    toggleCategoryFilter,

    // Pagination
    pageIndex,
    setPageIndex,
    pageSize,
    setPageSize,

    // Selection
    selectedIds,
    handleSelectAll,
    handleSelectOne,

    // Sheet
    sheetOpen,
    setSheetOpen,
    editingPainPoint,
    handleCreateNew,
    handleEdit,
    handleSave,
    handleSheetDelete,
    painPointRelations,
    handleAddRelation,
    handleRemoveRelation,

    // Delete dialog
    deleteDialogOpen,
    setDeleteDialogOpen,
    painPointToDelete,
    handleDeleteClick,
    handleConfirmDelete,

    // Bulk operations
    handleBulkDelete,
    bulkDeleteMutation,

    // Query client for error retry
    queryClient,
  };
}
