'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { getStrategies, deleteStrategy, type Strategy } from '@/lib/strategies';
import { resolveStrategyCreateOutcome, resolveStrategyUpdateOutcome } from '@/lib/mutation-outcome/strategy';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { getRelationsForEntity, getRelationsForEntities, deleteRelation, createRelationFromIds } from '@/lib/relations';
import type { Relation, EntityType, RelationType } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';

const log = createLogger('hooks/useStrategiesPage');
import { useControlledSheet } from '@/hooks/useSheetUrl';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { parseBulkDeleteAcknowledgement } from '@/lib/bulk-delete-acknowledgement';
import type { SortConfig } from '@/components/library/shared/types';
import type { StrategyFormValues } from '@/components/sheets/StrategySheet';

export function useStrategiesPage() {
  const { toast } = useToast();
  const graphSync = useLibraryEntityGraphSync<Strategy>({
    entityType: 'strategy',
    entityTypeLabel: 'strategy',
    getName: (strategy) => strategy.name,
  });

  // Data state
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [relationsMap, setRelationsMap] = useState<Map<string, Relation[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  // Pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Sorting
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);

  // Filter
  const [searchQuery, setSearchQuery] = useState('');

  // Delete confirmation
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [strategyToDelete, setStrategyToDelete] = useState<Strategy | null>(null);

  // Bulk delete
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  // Selection
  const { selectedIds, isSelected, toggleSelection, handleSelectAllChange, clearSelection, setSelection, selectedCount } =
    useTableSelection<Strategy>({
      getItemId: (strategy) => strategy.id,
    });

  // Sheet state for adding new
  const [isAddingNew, setIsAddingNew] = useState(false);

  // URL-based sheet state
  const {
    selectedEntity: selectedStrategy,
    isOpen: isSheetOpen,
    open: openStrategySheet,
    close: closeStrategySheet,
    onOpenChange: handleSheetOpenChange,
  } = useControlledSheet({
    entities: strategies,
    getId: (s) => s.id,
    paramName: 'strategy',
  });

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await getStrategies();
      setStrategies(data);

      const relations = new Map<string, Relation[]>();
      try {
        const relationsByEntity = await getRelationsForEntities(data.map((strategy) => strategy.id));
        for (const [strategyId, strategyRelations] of Object.entries(relationsByEntity)) {
          if (strategyRelations.length > 0) {
            relations.set(strategyId, strategyRelations);
          }
        }
      } catch (error) {
        log.error('Failed to load relations', error instanceof Error ? error : new Error(String(error)));
      }
      setRelationsMap(relations);
    } catch (error) {
      log.error('Error loading strategies', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to load strategies. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useDataRefresh(['strategies', 'relations'], () => {
    loadData();
  });

  // ============================================================================
  // FILTERING + SORTING + PAGINATION
  // ============================================================================

  const filteredStrategies = useMemo(() => {
    let filtered = [...strategies];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(
        (strategy) =>
          strategy.name.toLowerCase().includes(query) ||
          strategy.description?.toLowerCase().includes(query) ||
          strategy.content?.toLowerCase().includes(query) ||
          strategy.mainDirectives?.some((d) => d.directive.toLowerCase().includes(query))
      );
    }

    return filtered;
  }, [strategies, searchQuery]);

  const sortedStrategies = useMemo(() => {
    if (!sortConfig) return filteredStrategies;

    return [...filteredStrategies].sort((a, b) => {
      let comparison = 0;

      switch (sortConfig.key) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'directives':
          comparison = (a.mainDirectives?.length || 0) - (b.mainDirectives?.length || 0);
          break;
        case 'documents':
          comparison = (a.documents?.length || 0) - (b.documents?.length || 0);
          break;
      }

      return sortConfig.direction === 'desc' ? -comparison : comparison;
    });
  }, [filteredStrategies, sortConfig]);

  const paginatedStrategies = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedStrategies.slice(start, start + pageSize);
  }, [sortedStrategies, pageIndex, pageSize]);

  const { isAllSelected, isSomeSelected } = useSelectionState(
    selectedIds,
    paginatedStrategies,
    (strategy) => strategy.id
  );

  // Reset page on filter change
  useEffect(() => {
    setPageIndex(0);
  }, [searchQuery]);

  // ============================================================================
  // HANDLERS
  // ============================================================================

  const handleSort = useCallback((key: string) => {
    setSortConfig((current) => {
      if (current?.key === key) {
        if (current.direction === 'asc') return { key, direction: 'desc' };
        return null;
      }
      return { key, direction: 'asc' };
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
  }, []);

  const handleSelectStrategy = useCallback(
    (strategy: Strategy) => {
      openStrategySheet(strategy);
    },
    [openStrategySheet]
  );

  const confirmDelete = useCallback((strategy: Strategy) => {
    setStrategyToDelete(strategy);
    setIsDeleteDialogOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!strategyToDelete) return;

    try {
      await deleteStrategy(strategyToDelete.id);
      toast({
        title: 'Strategy Deleted',
        description: `"${strategyToDelete.name}" has been deleted.`,
      });
      setIsDeleteDialogOpen(false);
      setStrategyToDelete(null);
      loadData();
    } catch (error) {
      log.error('Error deleting strategy', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete strategy.',
        variant: 'destructive',
      });
    }
  }, [strategyToDelete, toast, loadData]);

  const handleAddRelation = useCallback(
    async (targetId: string, targetType: EntityType, relationType: RelationType) => {
      if (!selectedStrategy) return;

      try {
        await createRelationFromIds({
          sourceId: selectedStrategy.id,
          sourceType: 'strategy',
          targetId,
          targetType,
          relationType,
        });
        toast({
          title: 'Relation added',
          description: 'The relation has been created successfully.',
        });
        const updatedRelations = await getRelationsForEntity(selectedStrategy.id);
        setRelationsMap((prev) => new Map(prev).set(selectedStrategy.id, updatedRelations));
      } catch (error) {
        log.error('Error adding relation', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to add relation.',
          variant: 'destructive',
        });
      }
    },
    [selectedStrategy, toast]
  );

  const handleRemoveRelation = useCallback(
    async (relationId: string) => {
      if (!selectedStrategy) return;

      try {
        await deleteRelation(relationId);
        toast({
          title: 'Relation removed',
          description: 'The relation has been removed successfully.',
        });
        const updatedRelations = await getRelationsForEntity(selectedStrategy.id);
        setRelationsMap((prev) => new Map(prev).set(selectedStrategy.id, updatedRelations));
      } catch (error) {
        log.error('Error removing relation', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to remove relation.',
          variant: 'destructive',
        });
      }
    },
    [selectedStrategy, toast]
  );

  const handleSave = useCallback(
    async (data: StrategyFormValues) => {
      try {
        // GRAPH-058: a committed write whose graph handoff was lost is reported
        // as saved-locally with a retry, never as "Failed to save strategy".
        if (isAddingNew) {
          const outcome = await resolveStrategyCreateOutcome({
            name: data.name,
            description: data.description,
            content: data.content || '',
            mainDirectives: data.mainDirectives || [],
            links: data.links || [],
            documents: [],
          });
          graphSync.applyOutcome(outcome, {
            applyCommitted: () => undefined,
            success: {
              title: 'Strategy created',
              description: `"${data.name}" has been created successfully.`,
            },
          });
        } else if (selectedStrategy) {
          const outcome = await resolveStrategyUpdateOutcome(selectedStrategy, {
            name: data.name,
            description: data.description,
            content: data.content || '',
            mainDirectives: data.mainDirectives || [],
            links: data.links || [],
          });
          graphSync.applyOutcome(outcome, {
            applyCommitted: () => undefined,
            success: {
              title: 'Strategy updated',
              description: `"${data.name}" has been updated successfully.`,
            },
          });
        }
        loadData();
        closeStrategySheet();
        setIsAddingNew(false);
      } catch (error) {
        log.error('Error saving strategy', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: `Failed to save strategy: ${error instanceof Error ? error.message : 'Unknown error'}`,
          variant: 'destructive',
        });
        throw error;
      }
    },
    [isAddingNew, selectedStrategy, toast, loadData, closeStrategySheet, graphSync]
  );

  const handleSheetDelete = selectedStrategy
    ? async () => {
        await deleteStrategy(selectedStrategy.id);
        toast({
          title: 'Strategy deleted',
          description: `"${selectedStrategy.name}" has been deleted.`,
        });
        loadData();
        closeStrategySheet();
      }
    : undefined;

  const handleBulkDelete = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/strategies/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete strategies');
      }

      const result = parseBulkDeleteAcknowledgement(
        await response.json(),
        selectedIds,
        ['relationsDeleted'] as const
      );
      toast({
        title: result.failed.length > 0 ? 'Strategies Partially Deleted' : 'Strategies Deleted',
        description: `Deleted ${result.deleted} ${result.deleted === 1 ? 'strategy' : 'strategies'}${result.relationsDeleted > 0 ? ` and ${result.relationsDeleted} relations` : ''}.${result.failed.length > 0 ? ` ${result.failed.length} retained for retry.` : ''}`,
        ...(result.failed.length > 0 ? { variant: 'destructive' as const } : {}),
      });
      setSelection(result.failed);
      loadData();
    } catch (error) {
      log.error('Error bulk deleting strategies', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete strategies.',
        variant: 'destructive',
      });
    }
  }, [selectedIds, toast, setSelection, loadData]);

  const hasActiveFilters = !!searchQuery;

  return {
    // GRAPH-058 saved-locally recovery
    graphSyncRecoveries: graphSync.recoveries,
    maxGraphSyncRetries: graphSync.maxRetryAttempts,
    graphSyncEntityTypeLabel: graphSync.entityTypeLabel,
    getGraphSyncRecoveryLabel: graphSync.getRecoveryLabel,
    retryGraphSync: graphSync.retryGraphSync,
    // Data
    strategies,
    sortedStrategies,
    paginatedStrategies,
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
    selectedStrategy,
    handleSelectStrategy,
    handleSheetOpenChange,
    closeStrategySheet,
    handleSave,
    handleSheetDelete,
    handleAddRelation,
    handleRemoveRelation,

    // Delete
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    strategyToDelete,
    confirmDelete,
    handleDelete,

    // Bulk
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,
  };
}
