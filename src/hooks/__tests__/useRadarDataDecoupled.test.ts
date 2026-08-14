/**
 * Integration Tests for useRadarDataDecoupled Hook
 *
 * Tests the data flow from hook → service → Firestore for the decoupled model.
 * Verifies:
 * - Technologies with placements are fetched correctly
 * - Legacy RadarEntry format is generated correctly
 * - Lookup maps are created properly
 * - Mutations (create, update, delete) work end-to-end
 *
 * @jest-environment jsdom
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  TechnologyWithPlacement,
  Technology,
  RadarPlacement,
  Ring,
  Quadrant,
  Status,
  TechnologyCategory,
} from '@/lib/types';

// Mock logger
jest.mock('@/lib/logger', () => {
  const _mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { createLogger: jest.fn(() => _mockLogger) };
});

// Mock the service modules
jest.mock('@/lib/radar-placement-service', () => ({
  getTechnologiesWithPlacementsForRadar: jest.fn(),
  createRadarPlacement: jest.fn(),
  updateRadarPlacement: jest.fn(),
  deleteRadarPlacement: jest.fn(),
}));

// Mock the radars service to break the Firebase init chain. The hook's new
// `useQuery` for radar config pulls in `getRadarById` from `@/lib/radars`,
// which transitively imports firebase-admin modules that fail in jsdom.
jest.mock('@/lib/radars', () => ({
  __esModule: true,
  getRadarById: jest.fn(() =>
    Promise.resolve({
      id: 'radar-1',
      name: 'Test Radar',
      quadrants: [
        { id: 'q_techniques', name: 'Techniques', order: 0 },
        { id: 'q_tools', name: 'Tools', order: 1 },
        { id: 'q_platforms', name: 'Platforms', order: 2 },
        { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
      ],
      entries: [],
    })
  ),
}));

// Break the Firebase init chain in jsdom
jest.mock('@/lib/firebase', () => ({ db: {} }));

// Import mocked modules
import {
  getTechnologiesWithPlacementsForRadar,
  createRadarPlacement,
  updateRadarPlacement,
  deleteRadarPlacement,
} from '@/lib/radar-placement-service';

// Import hook after mocks
import { useRadarDataDecoupled } from '../useRadarDataDecoupled';

// Get reference to mock logger after imports
const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

// Type the mocks
const mockGetTechnologiesWithPlacements = getTechnologiesWithPlacementsForRadar as jest.MockedFunction<
  typeof getTechnologiesWithPlacementsForRadar
>;
const mockCreateRadarPlacement = createRadarPlacement as jest.MockedFunction<typeof createRadarPlacement>;
const mockUpdateRadarPlacement = updateRadarPlacement as jest.MockedFunction<typeof updateRadarPlacement>;
const mockDeleteRadarPlacement = deleteRadarPlacement as jest.MockedFunction<typeof deleteRadarPlacement>;

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Create a mock Technology entity
 */
function createMockTechnology(overrides?: Partial<Technology>): Technology {
  return {
    id: 'tech-123',
    name: 'React',
    slug: 'react',
    description: 'A JavaScript library for building user interfaces',
    category: 'framework' as TechnologyCategory,
    tags: ['frontend', 'javascript'],
    websiteUrl: 'https://react.dev',
    createdBy: 'user-1',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock RadarPlacement entity
 */
function createMockPlacement(overrides?: Partial<RadarPlacement>): RadarPlacement {
  return {
    id: 'placement-123',
    technologyId: 'tech-123',
    radarId: 'radar-1',
    quadrantId: 'q_techniques' as Quadrant,
    ring: 'Adopt' as Ring,
    status: 'active' as Status,
    x: 0.5,
    y: 0.5,
    placedBy: 'user-1',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock TechnologyWithPlacement (combined entity)
 */
function createMockTechWithPlacement(
  techOverrides?: Partial<Technology>,
  placementOverrides?: Partial<RadarPlacement>
): TechnologyWithPlacement {
  const tech = createMockTechnology(techOverrides);
  const placement = createMockPlacement({
    technologyId: tech.id,
    ...placementOverrides,
  });
  return { ...tech, placement };
}

/**
 * Create wrapper with QueryClient for React Query hooks
 */
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
      },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('useRadarDataDecoupled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // DATA FETCHING
  // ============================================================================

  describe('data fetching', () => {
    it('should fetch technologies with placements for a radar', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }),
        createMockTechWithPlacement({ id: 'tech-2', name: 'Vue' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      // Initial state
      expect(result.current.isLoading).toBe(true);
      expect(result.current.technologies).toEqual([]);

      // Wait for data
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.technologies).toHaveLength(2);
      expect(result.current.technologies[0].name).toBe('React');
      expect(result.current.technologies[1].name).toBe('Vue');
      expect(mockGetTechnologiesWithPlacements).toHaveBeenCalledWith('radar-1');
    });

    it('should not fetch when radarId is undefined', () => {
      renderHook(() => useRadarDataDecoupled(undefined), { wrapper: createWrapper() });

      expect(mockGetTechnologiesWithPlacements).not.toHaveBeenCalled();
    });

    it('should handle fetch errors', async () => {
      const error = new Error('Network error');
      mockGetTechnologiesWithPlacements.mockRejectedValue(error);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.error?.message).toBe('Network error');
      expect(result.current.technologies).toEqual([]);
    });
  });

  // ============================================================================
  // LEGACY FORMAT CONVERSION
  // ============================================================================

  describe('legacy format conversion', () => {
    it('should convert technologies to RadarEntry format', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement(
          {
            id: 'tech-abc',
            name: 'React',
            description: 'UI Library',
            tags: ['frontend'],
          },
          {
            quadrantId: 'q_techniques' as Quadrant,
            ring: 'Adopt' as Ring,
            status: 'active' as Status,
            x: 0.3,
            y: 0.4,
          }
        ),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.entries).toHaveLength(1);

      const entry = result.current.entries[0];
      expect(entry.name).toBe('React');
      expect(entry.description).toBe('UI Library');
      expect(entry.quadrantId).toBe('q_techniques');
      expect(entry.ring).toBe('Adopt');
      expect(entry.status).toBe('active');
      expect(entry.x).toBe(0.3);
      expect(entry.y).toBe(0.4);
      expect(entry.tags).toEqual(['frontend']);
      // ID should be a hash of the technology ID
      expect(typeof entry.id).toBe('number');
    });

    it('should skip legacy format when includeLegacyFormat is false', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1', { includeLegacyFormat: false }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.entries).toEqual([]);
      expect(result.current.technologies).toHaveLength(1);
    });
  });

  // ============================================================================
  // LOOKUP MAPS
  // ============================================================================

  describe('lookup maps', () => {
    it('should create technologyMap for ID lookups', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }),
        createMockTechWithPlacement({ id: 'tech-2', name: 'Vue' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.technologyMap.size).toBe(2);
      expect(result.current.technologyMap.get('tech-1')?.name).toBe('React');
      expect(result.current.technologyMap.get('tech-2')?.name).toBe('Vue');
    });

    it('should create entryToTechnologyMap for reverse lookups', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-abc', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Get the entry ID (hash of tech ID)
      const entryId = result.current.entries[0].id;
      expect(result.current.entryToTechnologyMap.get(entryId)).toBe('tech-abc');
    });

    it('should provide getTechnologyForEntry utility', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-abc', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;
      const tech = result.current.getTechnologyForEntry(entryId);

      expect(tech?.id).toBe('tech-abc');
      expect(tech?.name).toBe('React');
    });

    it('should return undefined for unknown entry ID', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const tech = result.current.getTechnologyForEntry(99999);
      expect(tech).toBeUndefined();
    });

    it('should provide getTechnologyById utility', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-abc', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const tech = result.current.getTechnologyById('tech-abc');
      expect(tech?.name).toBe('React');
    });
  });

  // ============================================================================
  // MUTATIONS - CREATE
  // ============================================================================

  describe('mutations - createPlacement', () => {
    it('should create a new placement', async () => {
      const mockData: TechnologyWithPlacement[] = [];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockCreateRadarPlacement.mockResolvedValue({
        id: 'new-placement',
        technologyId: 'tech-1',
        radarId: 'radar-1',
        quadrantId: 'q_techniques' as Quadrant,
        ring: 'Adopt' as Ring,
        status: 'active' as Status,
        x: 0.5,
        y: 0.5,
        placedBy: 'user-1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.createPlacement({
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrantId: 'q_techniques' as Quadrant,
          ring: 'Adopt' as Ring,
          status: 'active' as Status,
          x: 0.5,
          y: 0.5,
          placedBy: 'user-1',
        });
      });

      // React Query passes additional args to mutationFn, so check first call's first arg
      expect(mockCreateRadarPlacement.mock.calls[0][0]).toEqual({
        technologyId: 'tech-1',
        radarId: 'radar-1',
        quadrantId: 'q_techniques',
        ring: 'Adopt',
        status: 'active',
        x: 0.5,
        y: 0.5,
        placedBy: 'user-1',
      });
    });
  });

  // ============================================================================
  // MUTATIONS - UPDATE
  // ============================================================================

  describe('mutations - updatePlacement', () => {
    it('should update an existing placement', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockUpdateRadarPlacement.mockResolvedValue(createMockPlacement());

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.updatePlacement('placement-1', { ring: 'Trial' as Ring });
      });

      expect(mockUpdateRadarPlacement).toHaveBeenCalledWith('placement-1', { ring: 'Trial' });
    });

    it('should update entry position by legacy ID', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-abc', name: 'React' }, { id: 'placement-xyz' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockUpdateRadarPlacement.mockResolvedValue(createMockPlacement());

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;

      await act(async () => {
        await result.current.updateEntryPosition(entryId, 0.7, 0.8);
      });

      expect(mockUpdateRadarPlacement).toHaveBeenCalledWith('placement-xyz', { x: 0.7, y: 0.8 });
    });

    it('should handle updateEntryPosition for non-existent entry', async () => {
      const mockData: TechnologyWithPlacement[] = [];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.updateEntryPosition(99999, 0.5, 0.5);
      });

      expect(mockUpdateRadarPlacement).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'No technology found for entry',
        expect.objectContaining({ entryId: 99999 })
      );
    });
  });

  // ============================================================================
  // MUTATIONS - DELETE
  // ============================================================================

  describe('mutations - deletePlacement', () => {
    it('should delete a placement', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.deletePlacement('placement-1');
      });

      // React Query passes additional args, so check first call's first arg
      expect(mockDeleteRadarPlacement.mock.calls[0][0]).toBe('placement-1');
    });
  });

  // ============================================================================
  // REFRESH
  // ============================================================================

  describe('refresh', () => {
    it('should refetch data when refresh is called', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGetTechnologiesWithPlacements).toHaveBeenCalledTimes(1);

      // Trigger refresh
      act(() => {
        result.current.refresh();
      });

      // Should trigger another fetch
      await waitFor(() => {
        expect(mockGetTechnologiesWithPlacements).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty data gracefully', async () => {
      mockGetTechnologiesWithPlacements.mockResolvedValue([]);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.technologies).toEqual([]);
      expect(result.current.entries).toEqual([]);
      expect(result.current.technologyMap.size).toBe(0);
      expect(result.current.entryToTechnologyMap.size).toBe(0);
    });

    it('should handle technologies with minimal data', async () => {
      const mockData: TechnologyWithPlacement[] = [
        {
          id: 'tech-1',
          name: 'Minimal Tech',
          slug: 'minimal-tech',
          description: '',
          category: 'tool' as TechnologyCategory,
          tags: [],
          createdBy: 'user-1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          placement: {
            id: 'p-1',
            technologyId: 'tech-1',
            radarId: 'radar-1',
            quadrantId: 'q_techniques' as Quadrant,
            ring: 'Hold' as Ring,
            status: 'new' as Status,
            x: 0.5,
            y: 0.5,
            placedBy: 'user-1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarDataDecoupled('radar-1'), { wrapper: createWrapper() });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.technologies).toHaveLength(1);
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries[0].description).toBe('');
    });
  });
});
