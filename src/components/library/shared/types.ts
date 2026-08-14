/**
 * Shared types for library page components (DataPagination, SortableHeader, etc.)
 * Used across all library/* pages that share the same table/grid patterns.
 */

export type SortDirection = "asc" | "desc";

export interface SortConfig {
  key: string;
  direction: SortDirection;
}

export interface PaginationState {
  pageIndex: number;
  pageSize: number;
}
