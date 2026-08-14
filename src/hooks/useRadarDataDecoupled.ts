/**
 * @file hooks/useRadarDataDecoupled.ts
 * @description Hook that loads radar data from the new decoupled model (Technology + RadarPlacement)
 * and provides it in both new format and legacy RadarEntry format for backward compatibility.
 *
 * This hook enables gradual migration from the legacy model to the new decoupled model.
 * Components can use either:
 * - `technologies` - New format (TechnologyWithPlacement[])
 * - `entries` - Legacy format (RadarEntry[])
 * - `getTechnologyForEntry` - Reverse lookup from legacy entry ID to technology
 *
 * Migration Strategy:
 * - Phase 1: Create this adapter hook (this file)
 * - Phase 2: Components gradually migrate to use `technologies` directly
 * - Phase 3: Remove legacy format support when all components migrated
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { useMemo, useCallback } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useRadarDataDecoupled');
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { technologyKeys, radarKeys } from '@/lib/query-keys';
import { getRadarById } from '@/lib/radars';
import {
  getTechnologiesWithPlacementsForRadar,
  createRadarPlacement,
  updateRadarPlacement,
  deleteRadarPlacement,
} from '@/lib/radar-placement-service';
import { toRadarEntries, createRadarEntryToTechnologyMap, createTechnologyLookupMap } from '@/lib/technology-adapters';
import type {
  TechnologyWithPlacement,
  RadarEntry,
  CreateRadarPlacementInput,
  RadarData,
  QuadrantConfig,
} from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

export interface UseRadarDataDecoupledOptions {
  /** Whether to also fetch the legacy format */
  includeLegacyFormat?: boolean;
}

export interface UseRadarDataDecoupledResult {
  // New format
  technologies: TechnologyWithPlacement[];
  technologyMap: Map<string, TechnologyWithPlacement>;

  // Legacy format (for backward compatibility)
  entries: RadarEntry[];
  entryToTechnologyMap: Map<number, string>;

  // State
  isLoading: boolean;
  isError: boolean;
  error: Error | null;

  // Mutations
  createPlacement: (data: CreateRadarPlacementInput) => Promise<void>;
  updatePlacement: (
    placementId: string,
    updates: Partial<Omit<TechnologyWithPlacement['placement'], 'id' | 'technologyId' | 'createdAt' | 'placedBy'>>
  ) => Promise<void>;
  deletePlacement: (placementId: string) => Promise<void>;
  updateEntryPosition: (entryId: number, x: number, y: number) => Promise<void>;

  // Utilities
  getTechnologyForEntry: (entryId: number) => TechnologyWithPlacement | undefined;
  getTechnologyById: (techId: string) => TechnologyWithPlacement | undefined;

  // Refresh
  refresh: () => void;
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook that provides radar data from the decoupled model with legacy compatibility
 *
 * @param radarId - The radar ID to load data for
 * @param options - Hook options
 * @returns Combined data in both new and legacy formats
 *
 * @example
 * ```tsx
 * function RadarPage({ radarId }) {
 *   const {
 *     entries,           // Use with legacy <Radar entries={entries} />
 *     technologies,      // Use with new model components
 *     getTechnologyForEntry,
 *     updateEntryPosition,
 *   } = useRadarDataDecoupled(radarId);
 *
 *   const handleEntryClick = (entry: RadarEntry) => {
 *     // Get full technology data from legacy entry ID
 *     const tech = getTechnologyForEntry(entry.id);
 *     if (tech) openTechnologySheet(tech.id);
 *   };
 * }
 * ```
 */
export function useRadarDataDecoupled(
  radarId: string | undefined,
  options: UseRadarDataDecoupledOptions = {}
): UseRadarDataDecoupledResult {
  const { includeLegacyFormat = true } = options;
  const queryClient = useQueryClient();

  // ============================================================================
  // QUERY: Load technologies with placements
  // ============================================================================

  const {
    data: technologies = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: technologyKeys.withPlacements(radarId),
    queryFn: () => getTechnologiesWithPlacementsForRadar(radarId!),
    enabled: !!radarId,
  });

  // Also load the radar itself so the adapter can denormalize `quadrantName`
  // onto each legacy-format entry. This is a separate query so it can be
  // cached independently of the placements query.
  const { data: radar } = useQuery<RadarData | null>({
    queryKey: radarKeys.detail(radarId ?? ''),
    queryFn: () => getRadarById(radarId!),
    enabled: !!radarId,
  });

  // ============================================================================
  // DERIVED DATA: Create lookup maps and legacy format
  // ============================================================================

  const technologyMap = useMemo(() => createTechnologyLookupMap(technologies), [technologies]);

  const entryToTechnologyMap = useMemo(() => createRadarEntryToTechnologyMap(technologies), [technologies]);

  const entries = useMemo(() => {
    if (!includeLegacyFormat) return [];
    // Gate on the radar being loaded with a non-empty quadrants list. The
    // adapter uses the radar's configs to resolve `quadrantId` + `quadrantName`
    // on every placement (including the legacy-name fallback). If we build
    // entries with an empty config list, every entry ends up with an unknown
    // quadrantId, which triggers the "unknown quadrantId" error in
    // `calculateRadarPositions`. Better to render zero entries until the
    // radar query resolves — the UI already handles loading state.
    if (!radar || !Array.isArray(radar.quadrants) || radar.quadrants.length === 0) {
      return [];
    }

    // Normalize legacy string[] quadrants to QuadrantConfig[] so the adapter
    // always receives the canonical shape. Pre-migration radar docs still
    // store `quadrants: ["Techniques", "Tools", ...]` — we can't have the
    // adapter do name→id resolution without real configs.
    const rawQuadrants: unknown[] = radar.quadrants as unknown[];
    const first = rawQuadrants[0];
    const isAlreadyConfig = typeof first === 'object' && first !== null && 'id' in first && 'name' in first;

    const normalizedConfigs: QuadrantConfig[] = isAlreadyConfig
      ? (rawQuadrants as QuadrantConfig[])
      : rawQuadrants.map((name, i) => ({
          id: `legacy-${i}`,
          name: String(name),
          order: i,
        }));

    return toRadarEntries(technologies, { quadrants: normalizedConfigs });
  }, [technologies, includeLegacyFormat, radar]);

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  const getTechnologyForEntry = useCallback(
    (entryId: number): TechnologyWithPlacement | undefined => {
      const techId = entryToTechnologyMap.get(entryId);
      return techId ? technologyMap.get(techId) : undefined;
    },
    [entryToTechnologyMap, technologyMap]
  );

  const getTechnologyById = useCallback(
    (techId: string): TechnologyWithPlacement | undefined => {
      return technologyMap.get(techId);
    },
    [technologyMap]
  );

  // ============================================================================
  // MUTATIONS
  // ============================================================================

  const createPlacementMutation = useMutation({
    mutationFn: createRadarPlacement,
    onSuccess: () => {
      if (radarId) {
        queryClient.invalidateQueries({
          queryKey: technologyKeys.withPlacements(radarId),
        });
      }
    },
  });

  const updatePlacementMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Record<string, unknown> }) =>
      updateRadarPlacement(id, updates),
    onSuccess: () => {
      if (radarId) {
        queryClient.invalidateQueries({
          queryKey: technologyKeys.withPlacements(radarId),
        });
      }
    },
  });

  const deletePlacementMutation = useMutation({
    mutationFn: deleteRadarPlacement,
    onSuccess: () => {
      if (radarId) {
        queryClient.invalidateQueries({
          queryKey: technologyKeys.withPlacements(radarId),
        });
      }
    },
  });

  // ============================================================================
  // WRAPPED MUTATION FUNCTIONS
  // ============================================================================

  const createPlacement = useCallback(
    async (data: CreateRadarPlacementInput): Promise<void> => {
      await createPlacementMutation.mutateAsync(data);
    },
    [createPlacementMutation]
  );

  const updatePlacement = useCallback(
    async (
      placementId: string,
      updates: Partial<Omit<TechnologyWithPlacement['placement'], 'id' | 'technologyId' | 'createdAt' | 'placedBy'>>
    ): Promise<void> => {
      await updatePlacementMutation.mutateAsync({ id: placementId, updates });
    },
    [updatePlacementMutation]
  );

  const deletePlacement = useCallback(
    async (placementId: string): Promise<void> => {
      await deletePlacementMutation.mutateAsync(placementId);
    },
    [deletePlacementMutation]
  );

  /**
   * Update entry position by legacy entry ID
   * Converts legacy ID to placement ID and updates position
   */
  const updateEntryPosition = useCallback(
    async (entryId: number, x: number, y: number): Promise<void> => {
      const tech = getTechnologyForEntry(entryId);
      if (!tech) {
        log.warn('No technology found for entry', { entryId });
        return;
      }

      await updatePlacement(tech.placement.id, { x, y });
    },
    [getTechnologyForEntry, updatePlacement]
  );

  // ============================================================================
  // REFRESH
  // ============================================================================

  const refresh = useCallback(() => {
    refetch();
  }, [refetch]);

  // ============================================================================
  // RETURN
  // ============================================================================

  return {
    // New format
    technologies,
    technologyMap,

    // Legacy format
    entries,
    entryToTechnologyMap,

    // State
    isLoading,
    isError,
    error: error as Error | null,

    // Mutations
    createPlacement,
    updatePlacement,
    deletePlacement,
    updateEntryPosition,

    // Utilities
    getTechnologyForEntry,
    getTechnologyById,

    // Refresh
    refresh,
  };
}

// ============================================================================
// RE-EXPORTS
// ============================================================================

export { hashStringToNumber } from '@/lib/technology-adapters';
