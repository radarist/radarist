/**
 * Unit Tests for useReportsPage Hook
 *
 * Tests the page-level state management hook that combines:
 * - useReports() for data fetching
 * - useTableSelection for row selection
 * - Local state for filters, sort, pagination, bulk delete
 * - formatDate utility function
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import type { Report } from '@/lib/schemas/report';

// ============================================================================
// MOCKS — jest.mock factories are hoisted above const, so use jest.fn() inline
// ============================================================================

// Mock Firebase to prevent initialization (fetch-with-auth imports firebase)
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

jest.mock('@/hooks/useReports', () => ({
  useReports: jest.fn(),
  useDeleteReport: jest.fn().mockReturnValue({ mutateAsync: jest.fn() }),
  useBulkDeleteReports: jest.fn().mockReturnValue({ mutateAsync: jest.fn() }),
  useUpdateReport: jest.fn().mockReturnValue({ mutateAsync: jest.fn() }),
}));

jest.mock('@/hooks/use-table-selection', () => ({
  useTableSelection: jest.fn().mockReturnValue({
    selectedIds: [],
    isSelected: jest.fn().mockReturnValue(false),
    toggleSelection: jest.fn(),
    handleSelectAllChange: jest.fn(),
    clearSelection: jest.fn(),
    selectedCount: 0,
  }),
  useSelectionState: jest.fn().mockReturnValue({
    isAllSelected: false,
    isSomeSelected: false,
  }),
}));

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

// Import AFTER mocks
import { useReportsPage, formatDate } from '../useReportsPage';
import { useReports } from '@/hooks/useReports';

const mockedUseReports = useReports as jest.MockedFunction<typeof useReports>;
const mockRefetch = jest.fn();

// ============================================================================
// TEST DATA
// ============================================================================

function makeReport(overrides: Partial<Report> & { id: string; title: string }): Report {
  return {
    html: '<html></html>',
    createdAt: '2026-02-25T10:00:00.000Z',
    createdBy: 'agent',
    shared: false,
    entityIds: [],
    metadata: {
      description: 'A report',
      dataSnapshotAt: '2026-02-25T09:00:00.000Z',
    },
    ...overrides,
  };
}

const MOCK_REPORTS: Report[] = [
  makeReport({ id: 'r1', title: 'Alpha Report', createdAt: '2026-02-25T10:00:00.000Z', createdBy: 'agent' }),
  makeReport({
    id: 'r2',
    title: 'Beta Report',
    createdAt: '2026-02-24T08:00:00.000Z',
    createdBy: 'user',
    shared: true,
  }),
  makeReport({
    id: 'r3',
    title: 'Gamma Report',
    createdAt: '2026-02-23T06:00:00.000Z',
    createdBy: 'agent',
    shared: false,
  }),
  makeReport({
    id: 'r4',
    title: 'Delta Report',
    createdAt: '2026-02-22T04:00:00.000Z',
    createdBy: 'user',
    metadata: { description: 'Delta description with keyword', dataSnapshotAt: '2026-02-22T03:00:00.000Z' },
  }),
];

// ============================================================================
// TEST SUITE
// ============================================================================

describe('useReportsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseReports.mockReturnValue({
      data: MOCK_REPORTS,
      isLoading: false,
      error: null,
      refetch: mockRefetch,
    } as unknown as ReturnType<typeof useReports>);
  });

  // ==========================================================================
  // INITIAL STATE
  // ==========================================================================

  describe('initial state', () => {
    it('should return correct default values', () => {
      const { result } = renderHook(() => useReportsPage());

      expect(result.current.pageIndex).toBe(0);
      expect(result.current.pageSize).toBe(10);
      expect(result.current.searchQuery).toBe('');
      expect(result.current.sortState).toEqual({ key: 'createdAt', direction: 'desc' });
      expect(result.current.hasActiveFilters).toBe(false);
      expect(result.current.showBulkDeleteDialog).toBe(false);
    });

    it('should return all reports when no filters are active', () => {
      const { result } = renderHook(() => useReportsPage());

      expect(result.current.totalCount).toBe(4);
      expect(result.current.filteredCount).toBe(4);
      // Default sort is createdAt desc, so newest first
      expect(result.current.reports[0].id).toBe('r1');
      expect(result.current.reports[3].id).toBe('r4');
    });
  });

  // ==========================================================================
  // FILTERING
  // ==========================================================================

  describe('filtering', () => {
    it('should filter reports by title when searchQuery is set', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setSearchQuery('Alpha');
      });

      expect(result.current.filteredCount).toBe(1);
      expect(result.current.reports[0].title).toBe('Alpha Report');
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should filter reports by description when searchQuery matches metadata', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setSearchQuery('keyword');
      });

      expect(result.current.filteredCount).toBe(1);
      expect(result.current.reports[0].id).toBe('r4');
    });

    // P-B14: titles arrive from the API already entity-decoded at the read
    // boundary (normalizeReportDoc in lib/reports.ts), so searching the
    // decoded character ("&") matches — and the encoded artifact ("amp")
    // does not false-match — the title the user actually sees.
    it('should match "&" against a decoded title and not false-match on "amp"', () => {
      mockedUseReports.mockReturnValue({
        data: [...MOCK_REPORTS, makeReport({ id: 'r5', title: 'MCP & The Production Reality Check' })],
        isLoading: false,
        error: null,
        refetch: mockRefetch,
      } as unknown as ReturnType<typeof useReports>);
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setSearchQuery('&');
      });
      expect(result.current.filteredCount).toBe(1);
      expect(result.current.reports[0].id).toBe('r5');

      act(() => {
        result.current.setSearchQuery('amp');
      });
      expect(result.current.filteredCount).toBe(0);
    });

    it('should filter by createdBy when createdByFilter is set', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setCreatedByFilter('user');
      });

      expect(result.current.filteredCount).toBe(2);
      expect(result.current.reports.every((r) => r.createdBy === 'user')).toBe(true);
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should filter to shared reports when sharedFilter is "shared"', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setSharedFilter('shared');
      });

      expect(result.current.filteredCount).toBe(1);
      expect(result.current.reports[0].id).toBe('r2');
      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should filter to private reports when sharedFilter is "private"', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setSharedFilter('private');
      });

      expect(result.current.filteredCount).toBe(3);
      expect(result.current.reports.every((r) => r.shared !== true)).toBe(true);
    });
  });

  // ==========================================================================
  // SORTING
  // ==========================================================================

  describe('sorting', () => {
    it('should sort by title ascending on first toggleSort("title")', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.toggleSort('title');
      });

      expect(result.current.sortState).toEqual({ key: 'title', direction: 'asc' });
      // Alphabetical asc: Alpha, Beta, Delta, Gamma
      expect(result.current.reports[0].title).toBe('Alpha Report');
      expect(result.current.reports[3].title).toBe('Gamma Report');
    });

    it('should toggle title sort to descending on second call', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.toggleSort('title');
      });
      act(() => {
        result.current.toggleSort('title');
      });

      expect(result.current.sortState).toEqual({ key: 'title', direction: 'desc' });
      expect(result.current.reports[0].title).toBe('Gamma Report');
      expect(result.current.reports[3].title).toBe('Alpha Report');
    });
  });

  // ==========================================================================
  // PAGINATION
  // ==========================================================================

  describe('pagination', () => {
    it('should slice reports based on pageIndex and pageSize', () => {
      const { result } = renderHook(() => useReportsPage());

      // With pageSize 10 and 4 reports, all should be on page 0
      expect(result.current.reports).toHaveLength(4);

      // Set small page size
      act(() => {
        result.current.setPageSize(2);
      });

      expect(result.current.reports).toHaveLength(2);

      // Move to page 1
      act(() => {
        result.current.setPageIndex(1);
      });

      expect(result.current.reports).toHaveLength(2);
      expect(result.current.filteredCount).toBe(4);
    });
  });

  // ==========================================================================
  // hasActiveFilters
  // ==========================================================================

  describe('hasActiveFilters', () => {
    it('should return false when no filters are active', () => {
      const { result } = renderHook(() => useReportsPage());
      expect(result.current.hasActiveFilters).toBe(false);
    });

    it('should return true when searchQuery is set', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setSearchQuery('test');
      });

      expect(result.current.hasActiveFilters).toBe(true);
    });

    it('should return true when createdByFilter is not "all"', () => {
      const { result } = renderHook(() => useReportsPage());

      act(() => {
        result.current.setCreatedByFilter('agent');
      });

      expect(result.current.hasActiveFilters).toBe(true);
    });
  });

  // ==========================================================================
  // formatDate
  // ==========================================================================

  describe('formatDate', () => {
    it('should return "Today" for today\'s date', () => {
      const now = new Date();
      expect(formatDate(now.toISOString())).toBe('Today');
    });

    it('should return "Yesterday" for yesterday\'s date', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(formatDate(yesterday.toISOString())).toBe('Yesterday');
    });

    it('should return "X days ago" for dates within the last week', () => {
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      expect(formatDate(threeDaysAgo.toISOString())).toBe('3 days ago');
    });

    it('should return formatted date for dates older than a week', () => {
      // Use a fixed date well in the past
      const result = formatDate('2025-01-15T10:00:00.000Z');
      // Should be formatted like "Jan 15, 2025"
      expect(result).toMatch(/Jan\s+15,\s+2025/);
    });
  });
});
