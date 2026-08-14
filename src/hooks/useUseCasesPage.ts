'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { getUseCases, deleteUseCase } from '@/lib/use-cases';
import { resolveUseCaseCreateOutcome, resolveUseCaseUpdateOutcome } from '@/lib/mutation-outcome/use-case';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { getRelationsForEntity, getRelationsForEntities, deleteRelation } from '@/lib/relations';
import { createRelationFromIds, DuplicateRelationApiError } from '@/lib/relation-api-client';
import { createLogger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';

const log = createLogger('hooks/useUseCasesPage');
import { useControlledSheet } from '@/hooks/useSheetUrl';
import { useDataRefresh } from '@/hooks/useDataRefresh';
import { useTableSelection, useSelectionState } from '@/hooks/use-table-selection';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { parseBulkDeleteAcknowledgement } from '@/lib/bulk-delete-acknowledgement';
import type { UseCase, Relation, EntityType, RelationType } from '@/lib/types';
import type { UseCaseFormValues } from '@/components/sheets/UseCaseSheet';

// ============================================================================
// TYPES
// ============================================================================

type SortKey = 'title' | 'status' | 'category';
type SortDirection = 'asc' | 'desc';

export interface UseCaseSortConfig {
  key: SortKey;
  direction: SortDirection;
}

// Status order for sorting
const STATUS_ORDER: Record<string, number> = {
  Proposed: 0,
  'In Progress': 1,
  Implemented: 2,
  Archived: 3,
};

// ============================================================================
// HOOK
// ============================================================================

export function useUseCasesPage() {
  const { toast } = useToast();
  const graphSync = useLibraryEntityGraphSync<UseCase>({
    entityType: 'useCase',
    entityTypeLabel: 'use case',
    getName: (useCase) => useCase.title,
  });

  // Data state
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [relationsMap, setRelationsMap] = useState<Map<string, Relation[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  // View state
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');

  // Pagination
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Sorting
  const [sortConfig, setSortConfig] = useState<UseCaseSortConfig | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');

  // Delete confirmation
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [useCaseToDelete, setUseCaseToDelete] = useState<UseCase | null>(null);

  // Bulk delete
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  // Sheet state
  const [isAddingNew, setIsAddingNew] = useState(false);

  // Selection
  const {
    selectedIds,
    isSelected,
    toggleSelection,
    handleSelectAllChange,
    clearSelection,
    setSelection,
    selectedCount,
  } = useTableSelection<UseCase>({
    getItemId: (useCase) => useCase.id,
  });

  // URL-based sheet state
  const {
    selectedEntity: selectedUseCase,
    isOpen: isSheetOpen,
    open: openUseCaseSheet,
    close: closeUseCaseSheet,
    onOpenChange: handleSheetOpenChange,
  } = useControlledSheet({
    entities: useCases,
    getId: (uc) => uc.id,
    paramName: 'usecase',
  });

  // ============================================================================
  // DATA LOADING
  // ============================================================================

  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const cases = await getUseCases();
      setUseCases(cases);

      // Load relations for all use cases in a single bulk query (bounded concurrency)
      const relations = new Map<string, Relation[]>();
      try {
        const relationsByEntity = await getRelationsForEntities(cases.map((uc) => uc.id));
        for (const [entityId, entityRelations] of Object.entries(relationsByEntity)) {
          if (entityRelations.length > 0) {
            relations.set(entityId, entityRelations);
          }
        }
      } catch (error) {
        log.error('Failed to load relations', error instanceof Error ? error : new Error(String(error)));
      }
      setRelationsMap(relations);
    } catch (error) {
      log.error('Error loading use cases', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to load use cases. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useDataRefresh(['useCases', 'relations'], () => {
    loadData();
  });

  // ============================================================================
  // FILTERING + SORTING + PAGINATION
  // ============================================================================

  const filteredUseCases = useMemo(() => {
    let filtered = [...useCases];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(
        (uc) =>
          uc.title?.toLowerCase().includes(query) ||
          uc.description?.toLowerCase().includes(query) ||
          uc.problem?.toLowerCase().includes(query) ||
          uc.category?.toLowerCase().includes(query) ||
          uc.tags?.some((tag) => tag?.toLowerCase().includes(query))
      );
    }

    return filtered;
  }, [useCases, searchQuery]);

  const sortedUseCases = useMemo(() => {
    if (!sortConfig) return filteredUseCases;

    return [...filteredUseCases].sort((a, b) => {
      let comparison = 0;

      switch (sortConfig.key) {
        case 'title':
          comparison = (a.title || '').localeCompare(b.title || '');
          break;
        case 'status':
          comparison = (STATUS_ORDER[a.status] || 0) - (STATUS_ORDER[b.status] || 0);
          break;
        case 'category':
          comparison = (a.category || '').localeCompare(b.category || '');
          break;
      }

      return sortConfig.direction === 'desc' ? -comparison : comparison;
    });
  }, [filteredUseCases, sortConfig]);

  const paginatedUseCases = useMemo(() => {
    const start = pageIndex * pageSize;
    return sortedUseCases.slice(start, start + pageSize);
  }, [sortedUseCases, pageIndex, pageSize]);

  const { isAllSelected, isSomeSelected } = useSelectionState(selectedIds, paginatedUseCases, (useCase) => useCase.id);

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
        if (current.direction === 'asc') {
          return { key: sortKey, direction: 'desc' as const };
        }
        return null;
      }
      return { key: sortKey, direction: 'asc' as const };
    });
  }, []);

  const handleSelectUseCase = useCallback(
    (useCase: UseCase) => {
      setIsAddingNew(false);
      openUseCaseSheet(useCase);
    },
    [openUseCaseSheet]
  );

  const handleAddNew = useCallback(() => {
    setIsAddingNew(true);
    closeUseCaseSheet();
  }, [closeUseCaseSheet]);

  const confirmDelete = useCallback((useCase: UseCase) => {
    setUseCaseToDelete(useCase);
    setIsDeleteDialogOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!useCaseToDelete) return;

    try {
      await deleteUseCase(useCaseToDelete.id);
      toast({
        title: 'Use Case Deleted',
        description: `"${useCaseToDelete.title}" has been deleted.`,
      });
      setIsDeleteDialogOpen(false);
      setUseCaseToDelete(null);
      loadData();
    } catch (error) {
      log.error('Error deleting use case', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: 'Failed to delete use case.',
        variant: 'destructive',
      });
    }
  }, [useCaseToDelete, toast, loadData]);

  const handleBulkDelete = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/api/use-cases/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete use cases');
      }

      const result = parseBulkDeleteAcknowledgement(await response.json(), selectedIds, ['relationsDeleted'] as const);
      toast({
        title: result.failed.length > 0 ? 'Use Cases Partially Deleted' : 'Use Cases Deleted',
        description: `Deleted ${result.deleted} use ${result.deleted === 1 ? 'case' : 'cases'}${result.relationsDeleted > 0 ? ` and ${result.relationsDeleted} relations` : ''}.${result.failed.length > 0 ? ` ${result.failed.length} retained for retry.` : ''}`,
        ...(result.failed.length > 0 ? { variant: 'destructive' as const } : {}),
      });
      setSelection(result.failed);
      loadData();
    } catch (error) {
      log.error('Error bulk deleting use cases', error instanceof Error ? error : new Error(String(error)));
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete use cases.',
        variant: 'destructive',
      });
    }
  }, [selectedIds, toast, setSelection, loadData]);

  const handleSave = useCallback(
    async (data: UseCaseFormValues) => {
      try {
        // GRAPH-058: a committed write whose graph handoff was lost is reported
        // as saved-locally with a retry, never as a failed save.
        if (isAddingNew) {
          const outcome = await resolveUseCaseCreateOutcome({
            title: data.title,
            description: data.description,
            problem: data.problem,
            solution: data.solution,
            outcomes: data.outcomes,
            status: data.status,
            category: data.category,
            tags: data.tags,
            radarTechnologyIds: [],
            companyIds: [],
          });
          graphSync.applyOutcome(outcome, {
            applyCommitted: () => undefined,
            success: { title: 'Success', description: 'Use case created successfully' },
          });
        } else if (selectedUseCase) {
          const outcome = await resolveUseCaseUpdateOutcome(selectedUseCase, {
            title: data.title,
            description: data.description,
            problem: data.problem,
            solution: data.solution,
            outcomes: data.outcomes,
            status: data.status,
            category: data.category,
            tags: data.tags,
          });
          graphSync.applyOutcome(outcome, {
            applyCommitted: () => undefined,
            success: { title: 'Success', description: 'Use case updated successfully' },
          });
        }
        await loadData();
        closeUseCaseSheet();
        setIsAddingNew(false);
      } catch (error) {
        log.error('Error saving use case', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to save use case. Please try again.',
          variant: 'destructive',
        });
      }
    },
    [isAddingNew, selectedUseCase, toast, loadData, closeUseCaseSheet, graphSync]
  );

  // ============================================================================
  // RELATION HANDLERS
  // ============================================================================

  /**
   * UX-054 — create the relation through the canonical SERVER boundary.
   *
   * This used to resolve the target with an inline `switch` covering six of the
   * nine entity types the picker advertises. Pain Point, Org Unit, and
   * Initiative fell through to a null snapshot, so the Add closed having written
   * nothing while the picker removed the row exactly as it does on success.
   *
   * `/api/relations/from-ids` resolves BOTH endpoints server-side via the admin
   * `buildEntitySnapshot`, so every advertised type is covered by construction
   * and a foreign or invalid id fails loudly instead of writing a snapshot the
   * client made up. Failures rethrow: the picker treats a resolved promise as
   * success, so swallowing here is what made the silence possible.
   */
  const handleAddRelation = useCallback(
    async (targetId: string, targetType: EntityType, relationType: RelationType) => {
      const currentUseCase = isAddingNew ? null : selectedUseCase;
      if (!currentUseCase) {
        throw new Error('No use case is open to link from');
      }

      try {
        await createRelationFromIds({
          sourceId: currentUseCase.id,
          sourceType: 'useCase',
          targetId,
          targetType,
          relationType,
        });
      } catch (error) {
        if (error instanceof DuplicateRelationApiError) {
          toast({
            title: 'Already Linked',
            description: 'That relation already exists.',
            variant: 'destructive',
          });
        } else {
          log.error('Error adding relation', error instanceof Error ? error : new Error(String(error)));
          toast({
            title: 'Error',
            description: error instanceof Error ? error.message : 'Failed to add relation',
            variant: 'destructive',
          });
        }
        throw error;
      }

      // Refresh relations for the current use case
      const updatedRelations = await getRelationsForEntity(currentUseCase.id);
      setRelationsMap((prev) => {
        const newMap = new Map(prev);
        newMap.set(currentUseCase.id, updatedRelations);
        return newMap;
      });

      toast({
        title: 'Relation Added',
        description: `Linked ${currentUseCase.title} to the selected ${targetType}`,
      });
    },
    [isAddingNew, selectedUseCase, toast]
  );

  const handleRemoveRelation = useCallback(
    async (relationId: string) => {
      try {
        await deleteRelation(relationId);

        const currentUseCase = isAddingNew ? null : selectedUseCase;
        if (currentUseCase) {
          const updatedRelations = await getRelationsForEntity(currentUseCase.id);
          setRelationsMap((prev) => {
            const newMap = new Map(prev);
            newMap.set(currentUseCase.id, updatedRelations);
            return newMap;
          });
        }

        toast({
          title: 'Relation Removed',
          description: 'The relation has been removed',
        });
      } catch (error) {
        log.error('Error removing relation', error instanceof Error ? error : new Error(String(error)));
        toast({
          title: 'Error',
          description: 'Failed to remove relation',
          variant: 'destructive',
        });
      }
    },
    [isAddingNew, selectedUseCase, toast]
  );

  const handleEntityClick = useCallback((entityId: string, entityType: EntityType) => {
    log.info('Entity clicked', { entityType, entityId });
  }, []);

  const hasActiveFilters = !!searchQuery;

  return {
    // GRAPH-058 saved-locally recovery
    graphSyncRecoveries: graphSync.recoveries,
    maxGraphSyncRetries: graphSync.maxRetryAttempts,
    graphSyncEntityTypeLabel: graphSync.entityTypeLabel,
    getGraphSyncRecoveryLabel: graphSync.getRecoveryLabel,
    retryGraphSync: graphSync.retryGraphSync,
    // Data
    useCases,
    relationsMap,
    sortedUseCases,
    paginatedUseCases,
    isLoading,
    loadData,

    // View state
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    sortConfig,
    handleSort,
    hasActiveFilters,

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
    selectedUseCase,
    isSheetOpen,
    isAddingNew,
    handleSheetOpenChange,
    handleSelectUseCase,
    handleAddNew,
    handleSave,

    // Delete
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    useCaseToDelete,
    confirmDelete,
    handleDelete,

    // Bulk
    showBulkDeleteDialog,
    setShowBulkDeleteDialog,
    handleBulkDelete,

    // Relations
    handleAddRelation,
    handleRemoveRelation,
    handleEntityClick,
  };
}
