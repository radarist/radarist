/**
 * @file hooks/use-table-selection.ts
 * @description Custom hook for managing table row selection with bulk operations
 *
 * Provides a reusable selection state management system for data tables.
 * Supports select all, partial selection, and clear selection operations.
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

import { useState, useMemo, useCallback } from 'react';

export interface UseTableSelectionOptions<T> {
  /** Function to extract unique ID from item */
  getItemId: (item: T) => string;
  /** Optional items to exclude from selection (e.g., protected items) */
  excludeFromSelection?: (item: T) => boolean;
}

export interface UseTableSelectionReturn<T> {
  /** Currently selected item IDs */
  selectedIds: string[];
  /** Whether all visible items are selected */
  isAllSelected: boolean;
  /** Whether some but not all visible items are selected */
  isSomeSelected: boolean;
  /** Number of selected items */
  selectedCount: number;
  /** Check if a specific item is selected */
  isSelected: (item: T) => boolean;
  /** Toggle selection for a single item */
  toggleSelection: (item: T) => void;
  /** Select a single item */
  selectItem: (item: T) => void;
  /** Deselect a single item */
  deselectItem: (item: T) => void;
  /** Select all visible items */
  selectAll: (items: T[]) => void;
  /** Deselect all items */
  clearSelection: () => void;
  /** Replace the selection with an exact set of IDs */
  setSelection: (ids: readonly string[]) => void;
  /** Handle select all checkbox change */
  handleSelectAllChange: (checked: boolean, items: T[]) => void;
  /** Get selected items from a data array */
  getSelectedItems: (items: T[]) => T[];
}

/**
 * Hook for managing table row selection state.
 *
 * @param options - Configuration options
 * @returns Selection state and handlers
 *
 * @example
 * ```tsx
 * const {
 *   selectedIds,
 *   isAllSelected,
 *   isSomeSelected,
 *   toggleSelection,
 *   handleSelectAllChange,
 *   clearSelection,
 * } = useTableSelection({
 *   getItemId: (company) => company.id,
 *   excludeFromSelection: (company) => company.isProtected,
 * });
 *
 * // In header checkbox
 * <Checkbox
 *   checked={isAllSelected}
 *   onCheckedChange={(checked) => handleSelectAllChange(!!checked, companies)}
 *   className={isSomeSelected ? "opacity-50" : undefined}
 * />
 *
 * // In row checkbox
 * <Checkbox
 *   checked={isSelected(company)}
 *   onCheckedChange={() => toggleSelection(company)}
 * />
 * ```
 */
export function useTableSelection<T>(
  options: UseTableSelectionOptions<T>
): UseTableSelectionReturn<T> {
  const { getItemId, excludeFromSelection } = options;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const selectedCount = selectedIds.length;

  const isSelected = useCallback(
    (item: T) => selectedIds.includes(getItemId(item)),
    [selectedIds, getItemId]
  );

  const canBeSelected = useCallback(
    (item: T) => !excludeFromSelection || !excludeFromSelection(item),
    [excludeFromSelection]
  );

  const toggleSelection = useCallback(
    (item: T) => {
      if (!canBeSelected(item)) return;

      const id = getItemId(item);
      setSelectedIds((prev) =>
        prev.includes(id)
          ? prev.filter((selectedId) => selectedId !== id)
          : [...prev, id]
      );
    },
    [getItemId, canBeSelected]
  );

  const selectItem = useCallback(
    (item: T) => {
      if (!canBeSelected(item)) return;

      const id = getItemId(item);
      setSelectedIds((prev) =>
        prev.includes(id) ? prev : [...prev, id]
      );
    },
    [getItemId, canBeSelected]
  );

  const deselectItem = useCallback(
    (item: T) => {
      const id = getItemId(item);
      setSelectedIds((prev) => prev.filter((selectedId) => selectedId !== id));
    },
    [getItemId]
  );

  const selectAll = useCallback(
    (items: T[]) => {
      const selectableIds = items
        .filter(canBeSelected)
        .map(getItemId);
      setSelectedIds(selectableIds);
    },
    [getItemId, canBeSelected]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const setSelection = useCallback((ids: readonly string[]) => {
    setSelectedIds([...new Set(ids)]);
  }, []);

  const handleSelectAllChange = useCallback(
    (checked: boolean, items: T[]) => {
      if (checked) {
        selectAll(items);
      } else {
        clearSelection();
      }
    },
    [selectAll, clearSelection]
  );

  const getSelectedItems = useCallback(
    (items: T[]) => items.filter((item) => selectedIds.includes(getItemId(item))),
    [selectedIds, getItemId]
  );

  // Compute isAllSelected and isSomeSelected based on current selection
  // Note: These need to be recomputed when items change, so caller passes items
  const _createSelectionState = useMemo(() => {
    return {
      forItems: (items: T[]) => {
        const selectableItems = items.filter(canBeSelected);
        const selectableCount = selectableItems.length;
        const selectedInView = selectableItems.filter((item) =>
          selectedIds.includes(getItemId(item))
        ).length;

        return {
          isAllSelected: selectableCount > 0 && selectedInView === selectableCount,
          isSomeSelected: selectedInView > 0 && selectedInView < selectableCount,
        };
      },
    };
  }, [selectedIds, getItemId, canBeSelected]);

  // For backward compatibility, provide default values
  // Caller should use createSelectionState.forItems(items) for accurate values
  const isAllSelected = false;
  const isSomeSelected = selectedIds.length > 0;

  return {
    selectedIds,
    isAllSelected,
    isSomeSelected,
    selectedCount,
    isSelected,
    toggleSelection,
    selectItem,
    deselectItem,
    selectAll,
    clearSelection,
    setSelection,
    handleSelectAllChange,
    getSelectedItems,
  };
}

/**
 * Utility hook to get selection state for a specific set of items.
 * Use this in combination with useTableSelection to get accurate all/some selected state.
 */
export function useSelectionState<T>(
  selectedIds: string[],
  items: T[],
  getItemId: (item: T) => string,
  excludeFromSelection?: (item: T) => boolean
) {
  return useMemo(() => {
    const selectableItems = excludeFromSelection
      ? items.filter((item) => !excludeFromSelection(item))
      : items;
    const selectableCount = selectableItems.length;
    const selectedInView = selectableItems.filter((item) =>
      selectedIds.includes(getItemId(item))
    ).length;

    return {
      isAllSelected: selectableCount > 0 && selectedInView === selectableCount,
      isSomeSelected: selectedInView > 0 && selectedInView < selectableCount,
    };
  }, [selectedIds, items, getItemId, excludeFromSelection]);
}
