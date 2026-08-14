/**
 * @file hooks/__tests__/use-table-selection.test.ts
 * @description Tests for the useTableSelection and useSelectionState hooks
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

import { renderHook, act } from '@testing-library/react';
import { useTableSelection, useSelectionState } from '../use-table-selection';

// Mock item type for testing
interface TestItem {
  id: string;
  name: string;
  isProtected?: boolean;
}

// Helper to create test items
function createItems(count: number): TestItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i + 1}`,
    name: `Item ${i + 1}`,
  }));
}

describe('useTableSelection', () => {
  // ============================================================================
  // INITIAL STATE
  // ============================================================================

  describe('initial state', () => {
    it('should start with no selected items', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      expect(result.current.selectedIds).toEqual([]);
      expect(result.current.selectedCount).toBe(0);
      expect(result.current.isSomeSelected).toBe(false);
    });

    it('should return isAllSelected as false initially', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      expect(result.current.isAllSelected).toBe(false);
    });
  });

  // ============================================================================
  // SINGLE ITEM SELECTION
  // ============================================================================

  describe('single item selection', () => {
    it('should toggle selection for a single item', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const item: TestItem = { id: 'test-1', name: 'Test Item' };

      // Select item
      act(() => {
        result.current.toggleSelection(item);
      });

      expect(result.current.selectedIds).toContain('test-1');
      expect(result.current.selectedCount).toBe(1);
      expect(result.current.isSelected(item)).toBe(true);

      // Deselect item
      act(() => {
        result.current.toggleSelection(item);
      });

      expect(result.current.selectedIds).not.toContain('test-1');
      expect(result.current.selectedCount).toBe(0);
      expect(result.current.isSelected(item)).toBe(false);
    });

    it('should select a single item using selectItem', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const item: TestItem = { id: 'test-1', name: 'Test Item' };

      act(() => {
        result.current.selectItem(item);
      });

      expect(result.current.selectedIds).toContain('test-1');
      expect(result.current.isSelected(item)).toBe(true);
    });

    it('should not duplicate selection when selectItem is called twice', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const item: TestItem = { id: 'test-1', name: 'Test Item' };

      act(() => {
        result.current.selectItem(item);
        result.current.selectItem(item);
      });

      expect(result.current.selectedIds.filter((id) => id === 'test-1').length).toBe(1);
      expect(result.current.selectedCount).toBe(1);
    });

    it('should deselect a single item using deselectItem', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const item: TestItem = { id: 'test-1', name: 'Test Item' };

      // First select the item
      act(() => {
        result.current.selectItem(item);
      });

      expect(result.current.isSelected(item)).toBe(true);

      // Then deselect
      act(() => {
        result.current.deselectItem(item);
      });

      expect(result.current.isSelected(item)).toBe(false);
      expect(result.current.selectedCount).toBe(0);
    });
  });

  // ============================================================================
  // MULTIPLE ITEM SELECTION
  // ============================================================================

  describe('multiple item selection', () => {
    it('should select multiple items independently', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const items = createItems(3);

      act(() => {
        result.current.selectItem(items[0]);
        result.current.selectItem(items[1]);
      });

      expect(result.current.selectedCount).toBe(2);
      expect(result.current.isSelected(items[0])).toBe(true);
      expect(result.current.isSelected(items[1])).toBe(true);
      expect(result.current.isSelected(items[2])).toBe(false);
    });

    it('should select all items using selectAll', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const items = createItems(5);

      act(() => {
        result.current.selectAll(items);
      });

      expect(result.current.selectedCount).toBe(5);
      items.forEach((item) => {
        expect(result.current.isSelected(item)).toBe(true);
      });
    });

    it('should clear all selections using clearSelection', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const items = createItems(3);

      // Select all
      act(() => {
        result.current.selectAll(items);
      });

      expect(result.current.selectedCount).toBe(3);

      // Clear
      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedCount).toBe(0);
      expect(result.current.selectedIds).toEqual([]);
    });

    it('should replace selection with exact unique IDs', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      act(() => {
        result.current.setSelection(['failed-2', 'failed-1', 'failed-2']);
      });

      expect(result.current.selectedIds).toEqual(['failed-2', 'failed-1']);
      expect(result.current.selectedCount).toBe(2);
    });
  });

  // ============================================================================
  // SELECT ALL CHECKBOX HANDLER
  // ============================================================================

  describe('handleSelectAllChange', () => {
    it('should select all items when checked is true', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const items = createItems(3);

      act(() => {
        result.current.handleSelectAllChange(true, items);
      });

      expect(result.current.selectedCount).toBe(3);
    });

    it('should clear selection when checked is false', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const items = createItems(3);

      // First select all
      act(() => {
        result.current.selectAll(items);
      });

      // Then uncheck
      act(() => {
        result.current.handleSelectAllChange(false, items);
      });

      expect(result.current.selectedCount).toBe(0);
    });
  });

  // ============================================================================
  // EXCLUDE FROM SELECTION
  // ============================================================================

  describe('excludeFromSelection', () => {
    it('should not select excluded items via toggleSelection', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
          excludeFromSelection: (item) => item.isProtected === true,
        })
      );

      const protectedItem: TestItem = { id: 'protected-1', name: 'Protected', isProtected: true };

      act(() => {
        result.current.toggleSelection(protectedItem);
      });

      expect(result.current.isSelected(protectedItem)).toBe(false);
      expect(result.current.selectedCount).toBe(0);
    });

    it('should not select excluded items via selectItem', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
          excludeFromSelection: (item) => item.isProtected === true,
        })
      );

      const protectedItem: TestItem = { id: 'protected-1', name: 'Protected', isProtected: true };

      act(() => {
        result.current.selectItem(protectedItem);
      });

      expect(result.current.isSelected(protectedItem)).toBe(false);
    });

    it('should skip excluded items when selecting all', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
          excludeFromSelection: (item) => item.isProtected === true,
        })
      );

      const items: TestItem[] = [
        { id: 'item-1', name: 'Item 1' },
        { id: 'item-2', name: 'Item 2', isProtected: true },
        { id: 'item-3', name: 'Item 3' },
      ];

      act(() => {
        result.current.selectAll(items);
      });

      expect(result.current.selectedCount).toBe(2);
      expect(result.current.isSelected(items[0])).toBe(true);
      expect(result.current.isSelected(items[1])).toBe(false); // Protected
      expect(result.current.isSelected(items[2])).toBe(true);
    });
  });

  // ============================================================================
  // GET SELECTED ITEMS
  // ============================================================================

  describe('getSelectedItems', () => {
    it('should return selected items from a data array', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const items = createItems(5);

      act(() => {
        result.current.selectItem(items[0]);
        result.current.selectItem(items[2]);
        result.current.selectItem(items[4]);
      });

      const selectedItems = result.current.getSelectedItems(items);

      expect(selectedItems.length).toBe(3);
      expect(selectedItems).toContainEqual(items[0]);
      expect(selectedItems).toContainEqual(items[2]);
      expect(selectedItems).toContainEqual(items[4]);
    });

    it('should return empty array when nothing is selected', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      const items = createItems(3);
      const selectedItems = result.current.getSelectedItems(items);

      expect(selectedItems).toEqual([]);
    });
  });

  // ============================================================================
  // SELECTION STATE TRACKING
  // ============================================================================

  describe('selection state tracking', () => {
    it('should update isSomeSelected when items are selected', () => {
      const { result } = renderHook(() =>
        useTableSelection<TestItem>({
          getItemId: (item) => item.id,
        })
      );

      expect(result.current.isSomeSelected).toBe(false);

      const item: TestItem = { id: 'test-1', name: 'Test' };

      act(() => {
        result.current.selectItem(item);
      });

      expect(result.current.isSomeSelected).toBe(true);
    });
  });
});

// ============================================================================
// useSelectionState TESTS
// ============================================================================

describe('useSelectionState', () => {
  it('should return isAllSelected true when all items are selected', () => {
    const items = createItems(3);
    const selectedIds = ['item-1', 'item-2', 'item-3'];

    const { result } = renderHook(() =>
      useSelectionState(selectedIds, items, (item) => item.id)
    );

    expect(result.current.isAllSelected).toBe(true);
    expect(result.current.isSomeSelected).toBe(false);
  });

  it('should return isSomeSelected true when some items are selected', () => {
    const items = createItems(3);
    const selectedIds = ['item-1', 'item-2'];

    const { result } = renderHook(() =>
      useSelectionState(selectedIds, items, (item) => item.id)
    );

    expect(result.current.isAllSelected).toBe(false);
    expect(result.current.isSomeSelected).toBe(true);
  });

  it('should return both false when no items are selected', () => {
    const items = createItems(3);
    const selectedIds: string[] = [];

    const { result } = renderHook(() =>
      useSelectionState(selectedIds, items, (item) => item.id)
    );

    expect(result.current.isAllSelected).toBe(false);
    expect(result.current.isSomeSelected).toBe(false);
  });

  it('should handle empty items array', () => {
    const items: TestItem[] = [];
    const selectedIds: string[] = [];

    const { result } = renderHook(() =>
      useSelectionState(selectedIds, items, (item) => item.id)
    );

    expect(result.current.isAllSelected).toBe(false);
    expect(result.current.isSomeSelected).toBe(false);
  });

  it('should respect excludeFromSelection when calculating state', () => {
    const items: TestItem[] = [
      { id: 'item-1', name: 'Item 1' },
      { id: 'item-2', name: 'Item 2', isProtected: true },
      { id: 'item-3', name: 'Item 3' },
    ];
    // Only selectable items (item-1 and item-3) are selected
    const selectedIds = ['item-1', 'item-3'];

    const { result } = renderHook(() =>
      useSelectionState(
        selectedIds,
        items,
        (item) => item.id,
        (item) => item.isProtected === true
      )
    );

    // All selectable items are selected
    expect(result.current.isAllSelected).toBe(true);
    expect(result.current.isSomeSelected).toBe(false);
  });

  it('should update when selectedIds change', () => {
    const items = createItems(3);

    const { result, rerender } = renderHook(
      ({ selectedIds }) =>
        useSelectionState(selectedIds, items, (item) => item.id),
      { initialProps: { selectedIds: [] as string[] } }
    );

    expect(result.current.isAllSelected).toBe(false);
    expect(result.current.isSomeSelected).toBe(false);

    // Select one item
    rerender({ selectedIds: ['item-1'] });

    expect(result.current.isAllSelected).toBe(false);
    expect(result.current.isSomeSelected).toBe(true);

    // Select all items
    rerender({ selectedIds: ['item-1', 'item-2', 'item-3'] });

    expect(result.current.isAllSelected).toBe(true);
    expect(result.current.isSomeSelected).toBe(false);
  });

  it('should update when items change', () => {
    const selectedIds = ['item-1', 'item-2'];

    const { result, rerender } = renderHook(
      ({ items }) =>
        useSelectionState(selectedIds, items, (item: TestItem) => item.id),
      { initialProps: { items: createItems(2) } }
    );

    // All items selected
    expect(result.current.isAllSelected).toBe(true);

    // Add more items
    rerender({ items: createItems(4) });

    // Now only some are selected
    expect(result.current.isAllSelected).toBe(false);
    expect(result.current.isSomeSelected).toBe(true);
  });
});
