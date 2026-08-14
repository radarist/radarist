'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { getPrototypes, deletePrototype } from '@/lib/prototypes';
import { resolvePrototypeCreateOutcome, resolvePrototypeUpdateOutcome } from '@/lib/mutation-outcome/prototype';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { getRelationsForEntities, getRelationsForEntity, createRelation, deleteRelation } from '@/lib/relations';
import { buildTargetSnapshot } from '@/lib/relation-snapshot';
import type { Prototype, Relation, EntityType, RelationType, EntitySnapshot } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';

const log = createLogger('hooks/usePrototypesPage');
import { useControlledSheet } from '@/hooks/useSheetUrl';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { parseBulkDeleteAcknowledgement } from '@/lib/bulk-delete-acknowledgement';
import type { PrototypeFormValues } from '@/components/sheets/PrototypeSheet';

// ============================================================================
// CONSTANTS
// ============================================================================

type SortKey = 'name' | 'status' | 'businessUnit' | 'impact';
type SortDirection = 'asc' | 'desc';

export interface PrototypeSortConfig {
  key: SortKey;
  direction: SortDirection;
}

const STATUS_ORDER: Record<string, number> = {
  Ideation: 0,
  'In Development': 1,
  'Demo Ready': 2,
  Delivered: 3,
  Archived: 4,
};

// ============================================================================
// HOOK
// ============================================================================

export function usePrototypesPage() {
  const { toast } = useToast();
  const graphSync = useLibraryEntityGraphSync<Prototype>({
    entityType: 'prototype',
    entityTypeLabel: 'prototype',
    getName: (prototype) => prototype.name,
  });

  // Data state
  const [prototypes, setPrototypes] = useState<Prototype[]>([]);
  const [relationsMap, setRelationsMap] = useState<Map<string, Relation[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  // Pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Sorting
  const [sortConfig, setSortConfig] = useState<PrototypeSortConfig | null>(null);

  // Filter
  const [searchQuery, setSearchQuery] = useState('');

  // Delete confirmation
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [prototypeToDelete, setPrototypeToDelete] = useState<Prototype | null>(null);

  // Bulk delete
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  // Selection
  const { selectedIds, isSelected, toggleSelection, handleSelectAllChange, clearSelection, setSelection, selectedCount } =
    useTableSelection<Prototype>({
      getItemId: (prototype) => prototype.id,
    });

  // Sheet state for adding new
  const [isAddingNew, setIsAddingNew] = useState(false);

  // URL-based sheet state
  const {
    selectedEntity: selectedPrototype,
    isOpen: isSheetOpen,
    open: openPrototypeSheet,
    close: closePrototypeSheet,
    onOpenChange: handleSheetOpenChange,
  } = useControlledSheet({
    entities: prototypes,
    getId: (p) => p.id,
    paramName: 'prototype',
  });

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await getPrototypes();
      setPrototypes(data);

      const relations = new Map<string, Relation[]>();
      try {
        const relationsByEntity = await getRelationsForEntities(data.map((prototype) => prototype.id));
        for (const [prototypeId, prototypeRelations] of Object.entries(relationsByEntity)) {
          if (prototypeRelations.length > 0) {
            relations.set(prototypeId, prototypeRelations);
          }
        }
      } catch (error) {
        log.error('Failed to load relations', error instanceof Error ? error : new Error(String(error)));
      }
      setRelationsMap(relations);
    } catch (error) {
      log.error('Error loading prototypes', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to load experiments. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useDataRefresh(['prototypes', 'relations'], () => {
    loadData();
  });

  // ============================================================================
  // FILTERING + SORTING + PAGINATION
  // ============================================================================

  const filteredPrototypes = useMemo(() => {
    let filtered = [...prototypes];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(
        (prototype) =>
          prototype.name.toLowerCase().includes(query) ||
          prototype.description?.toLowerCase().includes(query) ||
          prototype.targetBusinessUnit?.toLowerCase().includes(query) ||
          prototype.impact?.type?.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [prototypes, searchQuery]);

  const sortedPrototypes = useMemo(() => {
    if (!sortConfig) return filteredPrototypes;

    return [...filteredPrototypes].sort((a, b) => {
      let comparison = 0;

      switch (sortConfig.key) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'status':
          comparison = (STATUS_ORDER[a.status] || 0) - (STATUS_ORDER[b.status] || 0);
          break;
        case 'businessUnit':
          comparison = (a.targetBusinessUnit || '').localeCompare(b.targetBusinessUnit || '');
          break;
        case 'impact':
          comparison = (a.impact?.estimatedValue || 0) - (b.impact?.estimatedValue || 0);
          break;
      }

      return sortConfig.direction === 'desc' ? -comparison : comparison;
    });
  }, [filteredPrototypes, sortConfig]);

  const paginatedPrototypes = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedPrototypes.slice(start, start + pageSize);
  }, [sortedPrototypes, pageIndex, pageSize]);

  const { isAllSelected, isSomeSelected } = useSelectionState(
    selectedIds,
    paginatedPrototypes,
    (prototype) => prototype.id
  );

  // Reset page on filter change
  useEffect(() => {
    setPageIndex(0);
  }, [searchQuery]);

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleSort = useCallback((key: string) => {
    const sortKey = key as SortKey;
    setSortConfig((current) => {
      if (current?.key === sortKey) {
        if (current.direction === 'asc') return { key: sortKey, direction: 'desc' as const };
        return null;
      }
      return { key: sortKey, direction: 'asc' as const };
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
  }, []);

  const handleSelectPrototype = useCallback(
    (prototype: Prototype) => {
      setIsAddingNew(false);
      openPrototypeSheet(prototype);
    },
    [openPrototypeSheet]
  );

  const handleAddNew = useCallback(() => {
    setIsAddingNew(true);
    closePrototypeSheet();
  }, [closePrototypeSheet]);

  const confirmDelete = useCallback((prototype: Prototype) => {
    setPrototypeToDelete(prototype);
    setIsDeleteDialogOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!prototypeToDelete) return;

    try {
      await deletePrototype(prototypeToDelete.id);
      toast({
        title: 'Experiment Deleted',
        description: `"${prototypeToDelete.name}" has been deleted.`,
      });
      setIsDeleteDialogOpen(false);
      setPrototypeToDelete(null);
      loadData();
    } catch (error) {
      log.error('Error deleting prototype', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete experiment.',
        variant: 'destructive',
      });
    }
  }, [prototypeToDelete, toast, loadData]);

  const handleSave = useCallback(
    async (data: PrototypeFormValues) => {
      try {
        // GRAPH-058: a committed write whose graph handoff was lost is reported
        // as saved-locally with a retry, never as a failed save.
        if (isAddingNew) {
          const outcome = await resolvePrototypeCreateOutcome({
            name: data.name,
            description: data.description,
            status: data.status,
            targetBusinessUnit: data.targetBusinessUnit,
            team: data.team,
            presentedTo: data.presentedTo,
            presentationDate: data.presentationDate,
            artifacts: {
              demoUrl: data.artifacts.demoUrl,
              repoUrl: data.artifacts.repoUrl,
              demoVideo: data.artifacts.demoVideo,
              presentations: [],
            },
            impact: data.impact,
            costs: data.costs
              ? {
                  ...data.costs,
                  lastUpdated: Date.now(),
                }
              : undefined,
            jiraEpic: data.jiraEpic,
            linkedTechnologies: [],
            linkedCompanies: [],
            linkedUseCases: [],
            linkedStrategies: [],
          });
          graphSync.applyOutcome(outcome, {
            applyCommitted: () => undefined,
            success: { title: 'Success', description: 'Prototype created successfully' },
          });
        } else if (selectedPrototype) {
          const outcome = await resolvePrototypeUpdateOutcome(selectedPrototype, {
            name: data.name,
            description: data.description,
            status: data.status,
            targetBusinessUnit: data.targetBusinessUnit,
            team: data.team,
            presentedTo: data.presentedTo,
            presentationDate: data.presentationDate,
            artifacts: {
              demoUrl: data.artifacts.demoUrl,
              repoUrl: data.artifacts.repoUrl,
              demoVideo: data.artifacts.demoVideo,
              presentations: selectedPrototype.artifacts?.presentations || [],
            },
            impact: data.impact,
            costs: data.costs
              ? {
                  ...data.costs,
                  lastUpdated: selectedPrototype.costs?.lastUpdated || Date.now(),
                }
              : undefined,
            jiraEpic: data.jiraEpic,
          });
          graphSync.applyOutcome(outcome, {
            applyCommitted: () => undefined,
            success: { title: 'Success', description: 'Prototype updated successfully' },
          });
        }
        await loadData();
        closePrototypeSheet();
        setIsAddingNew(false);
      } catch (error) {
        log.error('Error saving prototype', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to save prototype. Please try again.',
          variant: 'destructive',
        });
      }
    },
    [isAddingNew, selectedPrototype, toast, loadData, closePrototypeSheet, graphSync]
  );

  const handleSheetDelete = selectedPrototype
    ? async () => {
        // F76: actually delete. The footer Delete used to only reload + close,
        // so nothing was removed. Route through the same confirm→deletePrototype
        // flow the table row uses.
        closePrototypeSheet();
        confirmDelete(selectedPrototype);
      }
    : undefined;

  const handleBulkDelete = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/prototypes/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to delete prototypes');
      }

      const result = parseBulkDeleteAcknowledgement(
        await response.json(),
        selectedIds,
        ['relationsDeleted'] as const
      );
      toast({
        title: result.failed.length > 0 ? 'Experiments Partially Deleted' : 'Experiments Deleted',
        description: `Deleted ${result.deleted} experiment${result.deleted !== 1 ? 's' : ''}.${
          result.relationsDeleted > 0 ? ` (${result.relationsDeleted} relations removed)` : ''
        }${result.failed.length > 0 ? ` ${result.failed.length} retained for retry.` : ''}`,
        ...(result.failed.length > 0 ? { variant: 'destructive' as const } : {}),
      });

      setSelection(result.failed);
      loadData();
    } catch (error) {
      log.error('Error bulk deleting prototypes', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete experiments.',
        variant: 'destructive',
      });
    }
  }, [selectedIds, toast, setSelection, loadData]);

  // Relation add/remove lifecycle for the selected prototype (UX-033). The
  // page previously loaded relationsMap read-only and supplied no callbacks.
  const handleAddRelation = useCallback(
    async (targetId: string, targetType: EntityType, relationType: RelationType) => {
      if (!selectedPrototype) return;
      try {
        const sourceSnapshot: EntitySnapshot = {
          type: 'prototype',
          id: selectedPrototype.id,
          name: selectedPrototype.name,
          description: selectedPrototype.description,
          status: selectedPrototype.status,
          snapshotAt: Date.now(),
        };

        // Resolve the canonical target snapshot with the real name; a missing
        // target is a visible failure, not a silent empty-name write.
        const targetSnapshot = await buildTargetSnapshot(targetId, targetType);
        if (!targetSnapshot) {
          toast({ title: 'Error', description: 'Could not find the entity to link', variant: 'destructive' });
          return;
        }

        await createRelation({ relationType, sourceSnapshot, targetSnapshot });

        const updatedRelations = await getRelationsForEntity(selectedPrototype.id);
        setRelationsMap((prev) => new Map(prev).set(selectedPrototype.id, updatedRelations));
        toast({ title: 'Relation Added', description: `Linked ${selectedPrototype.name} to ${targetSnapshot.name}` });
      } catch (error) {
        log.error('Error adding relation', error instanceof Error ? error : new Error(String(error)));
        toast({ title: 'Error', description: 'Failed to add relation', variant: 'destructive' });
      }
    },
    [selectedPrototype, toast]
  );

  const handleRemoveRelation = useCallback(
    async (relationId: string) => {
      try {
        await deleteRelation(relationId);
        if (selectedPrototype) {
          const updatedRelations = await getRelationsForEntity(selectedPrototype.id);
          setRelationsMap((prev) => new Map(prev).set(selectedPrototype.id, updatedRelations));
        }
        toast({ title: 'Relation Removed', description: 'The relation has been removed' });
      } catch (error) {
        log.error('Error removing relation', error instanceof Error ? error : new Error(String(error)));
        toast({ title: 'Error', description: 'Failed to remove relation', variant: 'destructive' });
      }
    },
    [selectedPrototype, toast]
  );

  const hasActiveFilters = !!searchQuery;

  return {
    // GRAPH-058 saved-locally recovery
    graphSyncRecoveries: graphSync.recoveries,
    maxGraphSyncRetries: graphSync.maxRetryAttempts,
    graphSyncEntityTypeLabel: graphSync.entityTypeLabel,
    getGraphSyncRecoveryLabel: graphSync.getRecoveryLabel,
    retryGraphSync: graphSync.retryGraphSync,
    handleAddRelation,
    handleRemoveRelation,
    // Data
    prototypes,
    sortedPrototypes,
    paginatedPrototypes,
    relationsMap,
    isLoading,

    // View state
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    sortConfig,
    handleSort,
    hasActiveFilters,
    clearFilters,

    // Pagination
    pageIndex,
    setPageIndex,
    pageSize,
    setPageSize,

    // Selection
    selectedIds,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    selectedCount,
    isAllSelected,
    isSomeSelected,

    // Sheet
    isSheetOpen,
    isAddingNew,
    setIsAddingNew,
    selectedPrototype,
    handleSelectPrototype,
    handleAddNew,
    handleSheetOpenChange,
    closePrototypeSheet,
    handleSave,
    handleSheetDelete,

    // Delete
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    prototypeToDelete,
    confirmDelete,
    handleDelete,

    // Bulk
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  };
}
