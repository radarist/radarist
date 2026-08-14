/**
 * Integration Tests for useRadarEntriesDecoupled Hook
 *
 * Tests the full workflow of the decoupled radar entries hook:
 * - Backward compatibility with legacy useRadarEntries API
 * - CRUD operations through the decoupled model
 * - Tag filtering
 * - Entry state management (edit, research, hover)
 * - Position updates
 * - Analysis saving
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
  RadarEntry,
} from '@/lib/types';

// Mock Firebase to break init chain
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: { currentUser: { uid: 'test-user-123' } },
  storage: {},
  app: {},
}));

// Mock the service modules
jest.mock('@/lib/radar-placement-service', () => ({
  getTechnologiesWithPlacementsForRadar: jest.fn(),
  createRadarPlacement: jest.fn(),
  updateRadarPlacement: jest.fn(),
  deleteRadarPlacement: jest.fn(),
}));

jest.mock('@/lib/technology-service', () => ({
  createTechnology: jest.fn(),
  updateTechnology: jest.fn(),
  deleteTechnology: jest.fn(),
  getTechnologyById: jest.fn(),
  getTechnologyBySlug: jest.fn(),
}));

// Mock the radar service — `useRadarDataDecoupled` now gates entry
// construction on `getRadarById()` resolving with a non-empty quadrants list.
// Return a fixture with the 4 standard quadrants so the adapter can
// denormalize `quadrantName` onto every entry during tests.
jest.mock('@/lib/radars', () => ({
  __esModule: true,
  getRadarById: jest.fn().mockResolvedValue({
    id: 'radar-1',
    name: 'Test Radar',
    slug: 'test-radar',
    quadrants: [
      { id: 'q_techniques', name: 'Techniques', order: 0 },
      { id: 'q_tools', name: 'Tools', order: 1 },
      { id: 'q_platforms', name: 'Platforms', order: 2 },
      { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
    ],
    entries: [],
  }),
}));

// Import mocked modules
import {
  getTechnologiesWithPlacementsForRadar,
  createRadarPlacement,
  updateRadarPlacement,
  deleteRadarPlacement,
} from '@/lib/radar-placement-service';
import {
  createTechnology,
  updateTechnology,
  deleteTechnology,
  getTechnologyById,
  getTechnologyBySlug,
} from '@/lib/technology-service';

// Import hook after mocks
import { useRadarEntriesDecoupled } from '../useRadarEntriesDecoupled';

// Type the mocks
const mockGetTechnologiesWithPlacements = getTechnologiesWithPlacementsForRadar as jest.MockedFunction<
  typeof getTechnologiesWithPlacementsForRadar
>;
const mockCreateRadarPlacement = createRadarPlacement as jest.MockedFunction<typeof createRadarPlacement>;
const mockUpdateRadarPlacement = updateRadarPlacement as jest.MockedFunction<typeof updateRadarPlacement>;
const mockDeleteRadarPlacement = deleteRadarPlacement as jest.MockedFunction<typeof deleteRadarPlacement>;
const mockCreateTechnology = createTechnology as jest.MockedFunction<typeof createTechnology>;
const mockUpdateTechnology = updateTechnology as jest.MockedFunction<typeof updateTechnology>;
const mockDeleteTechnology = deleteTechnology as jest.MockedFunction<typeof deleteTechnology>;
const mockGetTechnologyById = getTechnologyById as jest.MockedFunction<typeof getTechnologyById>;
const mockGetTechnologyBySlug = getTechnologyBySlug as jest.MockedFunction<typeof getTechnologyBySlug>;

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Create a mock TechnologyWithPlacement entity
 */
function createMockTechWithPlacement(
  techOverrides?: Partial<Technology>,
  placementOverrides?: Partial<RadarPlacement>
): TechnologyWithPlacement {
  const tech: Technology = {
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
    ...techOverrides,
  };

  const placement: RadarPlacement = {
    id: 'placement-123',
    technologyId: tech.id,
    radarId: 'radar-1',
    quadrantId: 'q_techniques' as Quadrant,
    ring: 'Adopt' as Ring,
    status: 'active' as Status,
    x: 0.5,
    y: 0.5,
    placedBy: 'user-1',
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...placementOverrides,
  };

  return { ...tech, placement };
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

describe('useRadarEntriesDecoupled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // BASIC DATA LOADING
  // ============================================================================

  describe('data loading', () => {
    it('should load radar entries from decoupled model', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React', tags: ['frontend'] }),
        createMockTechWithPlacement({ id: 'tech-2', name: 'Vue', tags: ['frontend', 'framework'] }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.entries).toHaveLength(2);
      expect(result.current.filteredEntries).toHaveLength(2);
    });

    it('should expose technologies in new format', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.technologies).toHaveLength(1);
      expect(result.current.technologies[0].id).toBe('tech-1');
      expect(result.current.technologies[0].placement).toBeDefined();
    });
  });

  // ============================================================================
  // TAG FILTERING
  // ============================================================================

  describe('tag filtering', () => {
    it('should extract all unique tags', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', tags: ['frontend', 'javascript'] }),
        createMockTechWithPlacement({ id: 'tech-2', tags: ['backend', 'javascript'] }),
        createMockTechWithPlacement({ id: 'tech-3', tags: ['database'] }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.allTags).toContain('frontend');
      expect(result.current.allTags).toContain('backend');
      expect(result.current.allTags).toContain('javascript');
      expect(result.current.allTags).toContain('database');
      // Should have 4 unique tags
      expect(result.current.allTags).toHaveLength(4);
    });

    it('should filter entries by active tag', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React', tags: ['frontend'] }),
        createMockTechWithPlacement({ id: 'tech-2', name: 'Node', tags: ['backend'] }),
        createMockTechWithPlacement({ id: 'tech-3', name: 'Vue', tags: ['frontend'] }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.filteredEntries).toHaveLength(3);

      // Click frontend tag
      act(() => {
        result.current.handleTagClick('frontend');
      });

      expect(result.current.activeTags).toContain('frontend');
      expect(result.current.filteredEntries).toHaveLength(2);
      expect(result.current.filteredEntries.every((e) => e.tags?.includes('frontend'))).toBe(true);
    });

    it('should toggle tag off when clicked again', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', tags: ['frontend'] }),
        createMockTechWithPlacement({ id: 'tech-2', tags: ['backend'] }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Toggle on
      act(() => {
        result.current.handleTagClick('frontend');
      });
      expect(result.current.activeTags).toContain('frontend');

      // Toggle off
      act(() => {
        result.current.handleTagClick('frontend');
      });
      expect(result.current.activeTags).not.toContain('frontend');
      expect(result.current.filteredEntries).toHaveLength(2);
    });

    it('should clear all tags', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', tags: ['frontend', 'react'] }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.handleTagClick('frontend');
        result.current.handleTagClick('react');
      });
      expect(result.current.activeTags).toHaveLength(2);

      act(() => {
        result.current.handleClearTags();
      });
      expect(result.current.activeTags).toHaveLength(0);
    });
  });

  // ============================================================================
  // ENTRY STATE MANAGEMENT
  // ============================================================================

  describe('entry state management', () => {
    it('should manage hovered entry ID', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.hoveredEntryId).toBeNull();

      const entryId = result.current.entries[0].id;

      act(() => {
        result.current.setHoveredEntryId(entryId);
      });
      expect(result.current.hoveredEntryId).toBe(entryId);

      act(() => {
        result.current.setHoveredEntryId(null);
      });
      expect(result.current.hoveredEntryId).toBeNull();
    });

    it('should manage entry to edit', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.entryToEdit).toBeNull();

      act(() => {
        result.current.setEntryToEdit(result.current.entries[0]);
      });
      expect(result.current.entryToEdit?.name).toBe('React');

      act(() => {
        result.current.setEntryToEdit(null);
      });
      expect(result.current.entryToEdit).toBeNull();
    });

    it('should manage entry to research', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1', name: 'React' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.entryToResearch).toBeNull();

      act(() => {
        result.current.setEntryToResearch(result.current.entries[0]);
      });
      expect(result.current.entryToResearch?.name).toBe('React');
    });
  });

  // ============================================================================
  // SAVE ENTRY (CREATE/UPDATE)
  // ============================================================================

  describe('handleSaveEntry - create', () => {
    it('should create a new technology and placement', async () => {
      mockGetTechnologiesWithPlacements.mockResolvedValue([]);
      mockGetTechnologyBySlug.mockResolvedValue(null); // No existing technology
      mockCreateTechnology.mockResolvedValue({
        id: 'new-tech-id',
        name: 'New Tech',
        slug: 'new-tech',
        description: 'A new technology',
        category: 'tool' as TechnologyCategory,
        tags: ['new'],
        createdBy: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      mockCreateRadarPlacement.mockResolvedValue({
        id: 'new-placement-id',
        technologyId: 'new-tech-id',
        radarId: 'radar-1',
        quadrantId: 'q_techniques' as Quadrant,
        ring: 'Trial' as Ring,
        status: 'active' as Status,
        x: 0.5,
        y: 0.5,
        placedBy: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let savedEntry: RadarEntry | void = undefined;
      await act(async () => {
        savedEntry = await result.current.handleSaveEntry({
          name: 'New Tech',
          description: 'A new technology',
          quadrantId: 'q_techniques' as Quadrant,
          ring: 'Trial' as Ring,
          status: 'active' as Status,
          tags: ['new'],
          costToPrototype: 0,
          x: 0.5,
          y: 0.5,
        });
      });

      expect(mockCreateTechnology).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Tech',
          description: 'A new technology',
          tags: ['new'],
        })
      );

      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          technologyId: 'new-tech-id',
          radarId: 'radar-1',
          quadrantId: 'q_techniques',
          ring: 'Trial',
          status: 'active',
        })
      );

      // Should return entry with generated ID
      expect(savedEntry).toBeDefined();
      expect((savedEntry as RadarEntry | undefined)?.name).toBe('New Tech');
      expect(mockGetTechnologyById).not.toHaveBeenCalled();
      expect(mockGetTechnologyBySlug).toHaveBeenCalledWith('new-tech');
    });

    it('uses the selected Technology ID without a slug lookup or duplicate create', async () => {
      const selectedTechnology = createMockTechWithPlacement({
        id: 'selected-id',
        name: 'Selected Technology',
        slug: 'legacy-noncanonical-slug',
      });
      mockGetTechnologiesWithPlacements.mockResolvedValue([]);
      mockGetTechnologyById.mockResolvedValue(selectedTechnology);
      mockCreateRadarPlacement.mockResolvedValue(
        createMockPlacement({ technologyId: selectedTechnology.id, radarId: 'radar-1' })
      );

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleSaveEntry({
          technologyId: selectedTechnology.id,
          name: selectedTechnology.name,
          description: selectedTechnology.description,
          quadrantId: 'q_techniques',
          ring: 'Trial' as Ring,
          status: 'active' as Status,
          tags: selectedTechnology.tags,
          costToPrototype: 0,
        });
      });

      expect(mockGetTechnologyById).toHaveBeenCalledWith('selected-id');
      expect(mockGetTechnologyBySlug).not.toHaveBeenCalled();
      expect(mockCreateTechnology).not.toHaveBeenCalled();
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ technologyId: 'selected-id', radarId: 'radar-1' })
      );
    });

    it.each([
      ['missing', null],
      [
        'renamed',
        createMockTechWithPlacement({ id: 'selected-id', name: 'Renamed Technology' }),
      ],
    ])('fails closed when the selected Technology is %s', async (_case, resolvedTechnology) => {
      mockGetTechnologiesWithPlacements.mockResolvedValue([]);
      mockGetTechnologyById.mockResolvedValue(resolvedTechnology);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.handleSaveEntry({
            technologyId: 'selected-id',
            name: 'Selected Technology',
            description: 'An existing technology with enough detail',
            quadrantId: 'q_techniques',
            ring: 'Trial' as Ring,
            status: 'active' as Status,
            tags: ['existing'],
            costToPrototype: 0,
          });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toEqual(expect.objectContaining({ message: expect.stringMatching(/selected technology/i) }));
      expect(mockGetTechnologyBySlug).not.toHaveBeenCalled();
      expect(mockCreateTechnology).not.toHaveBeenCalled();
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
    });
  });

  describe('handleSaveEntry - update', () => {
    it('should update existing technology and placement', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }, { id: 'placement-1', ring: 'Adopt' as Ring }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockUpdateTechnology.mockResolvedValue(createMockTechWithPlacement({ id: 'tech-1', name: 'React Updated' }));
      mockUpdateRadarPlacement.mockResolvedValue(createMockPlacement({ id: 'placement-1' }));

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;

      await act(async () => {
        await result.current.handleSaveEntry({
          id: entryId,
          name: 'React Updated',
          description: 'Updated description',
          quadrantId: 'q_techniques' as Quadrant,
          ring: 'Trial' as Ring, // Changed from 1 to 2
          status: 'active' as Status,
          tags: ['frontend', 'updated'],
          costToPrototype: 0,
          x: 0.5,
          y: 0.5,
        });
      });

      expect(mockUpdateTechnology).toHaveBeenCalledWith(
        'tech-1',
        expect.objectContaining({
          name: 'React Updated',
          description: 'Updated description',
          tags: ['frontend', 'updated'],
        })
      );

      expect(mockUpdateRadarPlacement).toHaveBeenCalledWith(
        'placement-1',
        expect.objectContaining({
          ring: 'Trial',
        })
      );
    });

    it('should clear entryToEdit after save', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockUpdateTechnology.mockResolvedValue(createMockTechWithPlacement({ id: 'tech-1', name: 'React' }));
      mockUpdateRadarPlacement.mockResolvedValue(createMockPlacement({ id: 'placement-1' }));

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Set entry to edit
      act(() => {
        result.current.setEntryToEdit(result.current.entries[0]);
      });
      expect(result.current.entryToEdit).not.toBeNull();

      // Save
      const entryId = result.current.entries[0].id;
      await act(async () => {
        await result.current.handleSaveEntry({
          id: entryId,
          name: 'React',
          description: 'A JavaScript library for building user interfaces',
          quadrantId: 'q_techniques' as Quadrant,
          ring: 'Adopt' as Ring,
          status: 'active' as Status,
          tags: [],
          costToPrototype: 0,
          x: 0.5,
          y: 0.5,
        });
      });

      expect(result.current.entryToEdit).toBeNull();
    });
  });

  // ============================================================================
  // DELETE ENTRY
  // ============================================================================

  describe('handleDeleteEntry', () => {
    it('should delete a placement (not the technology)', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;

      await act(async () => {
        await result.current.handleDeleteEntry(entryId);
      });

      // Should delete placement, NOT the technology
      expect(mockDeleteRadarPlacement).toHaveBeenCalledWith('placement-1');
      expect(mockDeleteTechnology).not.toHaveBeenCalled();
    });

    it('should clear entryToResearch after delete', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockDeleteRadarPlacement.mockResolvedValue(undefined);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Set entry to research
      act(() => {
        result.current.setEntryToResearch(result.current.entries[0]);
      });
      expect(result.current.entryToResearch).not.toBeNull();

      // Delete
      const entryId = result.current.entries[0].id;
      await act(async () => {
        await result.current.handleDeleteEntry(entryId);
      });

      expect(result.current.entryToResearch).toBeNull();
    });

    it('should handle delete of non-existent entry gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockGetTechnologiesWithPlacements.mockResolvedValue([]);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.handleDeleteEntry(99999);
      });

      expect(mockDeleteRadarPlacement).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ============================================================================
  // SAVE ANALYSIS
  // ============================================================================

  describe('handleSaveAnalysis', () => {
    it('should save analysis to placement rationale', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1', name: 'React' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockUpdateRadarPlacement.mockResolvedValue(createMockPlacement());

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;

      await act(async () => {
        await result.current.handleSaveAnalysis(entryId, 'This is a detailed analysis of React');
      });

      expect(mockUpdateRadarPlacement).toHaveBeenCalledWith('placement-1', {
        rationale: 'This is a detailed analysis of React',
      });
    });

    it('should update local entryToResearch when saving analysis', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockUpdateRadarPlacement.mockResolvedValue(createMockPlacement());

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Set entry to research
      act(() => {
        result.current.setEntryToResearch(result.current.entries[0]);
      });

      const entryId = result.current.entries[0].id;

      await act(async () => {
        await result.current.handleSaveAnalysis(entryId, 'Updated analysis');
      });

      expect(result.current.entryToResearch?.analysis).toBe('Updated analysis');
    });
  });

  // ============================================================================
  // SAVE POSITION
  // ============================================================================

  describe('handleSaveEntryPosition', () => {
    it('should update entry position', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-1' }, { id: 'placement-1', x: 0.5, y: 0.5 }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);
      mockUpdateRadarPlacement.mockResolvedValue(createMockPlacement());

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;

      await act(async () => {
        await result.current.handleSaveEntryPosition(entryId, 0.7, 0.8);
      });

      expect(mockUpdateRadarPlacement).toHaveBeenCalledWith('placement-1', { x: 0.7, y: 0.8 });
    });
  });

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  describe('utility functions', () => {
    it('should provide getTechnologyId to map entry ID to tech ID', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement({ id: 'tech-abc' }, { id: 'placement-1' }),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;
      const techId = result.current.getTechnologyId(entryId);

      expect(techId).toBe('tech-abc');
    });

    it('should provide getTechnologyForEntry to get full tech data', async () => {
      const mockData: TechnologyWithPlacement[] = [
        createMockTechWithPlacement(
          { id: 'tech-abc', name: 'React', category: 'framework' as TechnologyCategory },
          { id: 'placement-1' }
        ),
      ];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const entryId = result.current.entries[0].id;
      const tech = result.current.getTechnologyForEntry(entryId);

      expect(tech?.id).toBe('tech-abc');
      expect(tech?.name).toBe('React');
      expect(tech?.category).toBe('framework');
      expect(tech?.placement.id).toBe('placement-1');
    });
  });

  // ============================================================================
  // REFRESH
  // ============================================================================

  describe('refresh', () => {
    it('should provide refresh function', async () => {
      const mockData: TechnologyWithPlacement[] = [createMockTechWithPlacement({ id: 'tech-1' })];
      mockGetTechnologiesWithPlacements.mockResolvedValue(mockData);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockGetTechnologiesWithPlacements).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.refresh();
      });

      await waitFor(() => {
        expect(mockGetTechnologiesWithPlacements).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ============================================================================
  // ERROR HANDLING
  // ============================================================================

  describe('error handling', () => {
    it('should expose error state', async () => {
      const error = new Error('Failed to fetch');
      mockGetTechnologiesWithPlacements.mockRejectedValue(error);

      const { result } = renderHook(() => useRadarEntriesDecoupled({ radarId: 'radar-1' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.entries).toEqual([]);
      expect(result.current.technologies).toEqual([]);
    });
  });
});
