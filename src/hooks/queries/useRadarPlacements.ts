/**
 * @file useRadarPlacements.ts
 * @description TanStack Query hooks for RadarPlacement entity (Phase 1)
 *
 * RadarPlacements capture WHERE a technology is placed on a radar (opinion).
 * Separate from Technology which captures WHAT the technology IS (fact).
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { radarPlacementKeys, technologyKeys } from '@/lib/query-keys'
import {
  getRadarPlacements,
  getPlacementsByRadar,
  getPlacementsForTechnology,
  getRadarPlacementById,
  getPlacementForTechnologyOnRadar,
  createRadarPlacement,
  updateRadarPlacement,
  moveTechnologyRing,
  deleteRadarPlacement,
  deleteAllPlacementsForTechnology,
  deleteAllPlacementsForRadar,
  getTechnologiesWithPlacementsForRadar,
  getRadarPlacementStats,
  type RadarPlacementFilters,
} from '@/lib/radar-placement-service'
import type {
  RadarPlacement,
  Ring,
  CreateRadarPlacementInput,
} from '@/lib/types'

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all radar placements with optional filters
 *
 * @example
 * const { data: placements, isLoading } = useRadarPlacements({ ring: 'Adopt' })
 */
export function useRadarPlacements(filters?: RadarPlacementFilters) {
  return useQuery({
    queryKey: radarPlacementKeys.list(filters),
    queryFn: () => getRadarPlacements(filters),
  })
}

/**
 * Fetch all placements for a specific radar
 *
 * @example
 * const { data: placements } = usePlacementsByRadar('my-radar')
 */
export function usePlacementsByRadar(radarId: string | undefined) {
  return useQuery({
    queryKey: radarPlacementKeys.byRadar(radarId!),
    queryFn: () => getPlacementsByRadar(radarId!),
    enabled: !!radarId,
  })
}

/**
 * Fetch all placements for a specific technology (across all radars)
 *
 * @example
 * const { data: placements } = usePlacementsForTechnology('tech-123')
 */
export function usePlacementsForTechnology(technologyId: string | undefined) {
  return useQuery({
    queryKey: radarPlacementKeys.byTechnology(technologyId!),
    queryFn: () => getPlacementsForTechnology(technologyId!),
    enabled: !!technologyId,
  })
}

/**
 * Fetch a single placement by ID
 *
 * @example
 * const { data: placement } = useRadarPlacement('placement-123')
 */
export function useRadarPlacement(id: string | undefined) {
  return useQuery({
    queryKey: radarPlacementKeys.detail(id!),
    queryFn: () => getRadarPlacementById(id!),
    enabled: !!id,
  })
}

/**
 * Fetch placement for a specific technology on a specific radar
 *
 * @example
 * const { data: placement } = usePlacementForTechnologyOnRadar('tech-123', 'my-radar')
 */
export function usePlacementForTechnologyOnRadar(
  technologyId: string | undefined,
  radarId: string | undefined
) {
  return useQuery({
    queryKey: [...radarPlacementKeys.all, 'tech-radar', technologyId, radarId] as const,
    queryFn: () => getPlacementForTechnologyOnRadar(technologyId!, radarId!),
    enabled: !!technologyId && !!radarId,
  })
}

/**
 * Fetch technologies with their placements for a specific radar
 * Combines Technology + RadarPlacement data for visualization
 *
 * @example
 * const { data: techsWithPlacements } = useTechnologiesWithPlacements('my-radar')
 */
export function useTechnologiesWithPlacements(radarId: string | undefined) {
  return useQuery({
    queryKey: technologyKeys.withPlacements(radarId),
    queryFn: () => getTechnologiesWithPlacementsForRadar(radarId!),
    enabled: !!radarId,
  })
}

/**
 * Fetch placement statistics for a radar
 *
 * @example
 * const { data: stats } = useRadarPlacementStats('my-radar')
 */
export function useRadarPlacementStats(radarId: string | undefined) {
  return useQuery({
    queryKey: [...radarPlacementKeys.byRadar(radarId!), 'stats'] as const,
    queryFn: () => getRadarPlacementStats(radarId!),
    enabled: !!radarId,
  })
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Create a new radar placement
 *
 * @example
 * const createMutation = useCreateRadarPlacement()
 * createMutation.mutate({
 *   technologyId: 'tech-123',
 *   radarId: 'my-radar',
 *   quadrant: 'languages-frameworks',
 *   ring: 'Trial',
 *   placedBy: 'user-456',
 * })
 */
export function useCreateRadarPlacement() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: CreateRadarPlacementInput) => createRadarPlacement(data),
    onSuccess: (_, variables) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: radarPlacementKeys.lists() })
      queryClient.invalidateQueries({
        queryKey: radarPlacementKeys.byRadar(variables.radarId),
      })
      queryClient.invalidateQueries({
        queryKey: radarPlacementKeys.byTechnology(variables.technologyId),
      })
      queryClient.invalidateQueries({
        queryKey: technologyKeys.withPlacements(variables.radarId),
      })
      // Also invalidate technology placements
      queryClient.invalidateQueries({
        queryKey: technologyKeys.placements(variables.technologyId),
      })
    },
  })
}

/**
 * Update an existing radar placement with optimistic update
 *
 * @example
 * const updateMutation = useUpdateRadarPlacement()
 * updateMutation.mutate({ id: 'placement-123', ring: 'Adopt', rationale: 'Mature enough' })
 */
export function useUpdateRadarPlacement() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: { id: string } & Partial<
      Omit<RadarPlacement, 'id' | 'technologyId' | 'createdAt' | 'placedBy'>
    >) => updateRadarPlacement(id, data),
    onMutate: async ({ id, ...data }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: radarPlacementKeys.detail(id) })

      // Snapshot previous value
      const previousPlacement = queryClient.getQueryData<RadarPlacement>(
        radarPlacementKeys.detail(id)
      )

      // Optimistically update the cache
      if (previousPlacement) {
        queryClient.setQueryData(radarPlacementKeys.detail(id), {
          ...previousPlacement,
          ...data,
          updatedAt: Date.now(),
        })
      }

      return { previousPlacement }
    },
    onError: (_err, { id }, context) => {
      // Rollback on error
      if (context?.previousPlacement) {
        queryClient.setQueryData(
          radarPlacementKeys.detail(id),
          context.previousPlacement
        )
      }
    },
    onSettled: (result) => {
      if (result) {
        // Refetch to ensure consistency
        queryClient.invalidateQueries({
          queryKey: radarPlacementKeys.detail(result.id),
        })
        queryClient.invalidateQueries({
          queryKey: radarPlacementKeys.byRadar(result.radarId),
        })
        queryClient.invalidateQueries({
          queryKey: radarPlacementKeys.byTechnology(result.technologyId),
        })
        queryClient.invalidateQueries({
          queryKey: technologyKeys.withPlacements(result.radarId),
        })
      }
    },
  })
}

/**
 * Move a technology to a different ring on a radar
 *
 * @example
 * const moveMutation = useMoveTechnologyRing()
 * moveMutation.mutate({ placementId: 'placement-123', newRing: 'Adopt', rationale: 'Ready for production' })
 */
export function useMoveTechnologyRing() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      placementId,
      newRing,
      rationale,
    }: {
      placementId: string
      newRing: Ring
      rationale?: string
    }) => moveTechnologyRing(placementId, newRing, rationale),
    onSuccess: (result) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({
        queryKey: radarPlacementKeys.detail(result.id),
      })
      queryClient.invalidateQueries({
        queryKey: radarPlacementKeys.byRadar(result.radarId),
      })
      queryClient.invalidateQueries({
        queryKey: radarPlacementKeys.byTechnology(result.technologyId),
      })
      queryClient.invalidateQueries({
        queryKey: technologyKeys.withPlacements(result.radarId),
      })
    },
  })
}

/**
 * Delete a radar placement
 *
 * @example
 * const deleteMutation = useDeleteRadarPlacement()
 * deleteMutation.mutate('placement-123')
 */
export function useDeleteRadarPlacement() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteRadarPlacement(id),
    onMutate: async (id) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: radarPlacementKeys.lists() })

      // Snapshot previous value
      const previousPlacements = queryClient.getQueryData<RadarPlacement[]>(
        radarPlacementKeys.lists()
      )

      // Optimistically remove from list
      if (previousPlacements) {
        queryClient.setQueryData(
          radarPlacementKeys.lists(),
          previousPlacements.filter((p) => p.id !== id)
        )
      }

      return { previousPlacements }
    },
    onError: (_err, _id, context) => {
      // Rollback on error
      if (context?.previousPlacements) {
        queryClient.setQueryData(
          radarPlacementKeys.lists(),
          context.previousPlacements
        )
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: radarPlacementKeys.all })
    },
  })
}

/**
 * Delete all placements for a technology (cascade delete)
 *
 * @example
 * const deleteAllMutation = useDeleteAllPlacementsForTechnology()
 * const count = await deleteAllMutation.mutateAsync('tech-123')
 */
export function useDeleteAllPlacementsForTechnology() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (technologyId: string) =>
      deleteAllPlacementsForTechnology(technologyId),
    onSuccess: (_, technologyId) => {
      queryClient.invalidateQueries({ queryKey: radarPlacementKeys.all })
      queryClient.invalidateQueries({
        queryKey: technologyKeys.placements(technologyId),
      })
    },
  })
}

/**
 * Delete all placements for a radar (cascade delete)
 *
 * @example
 * const deleteAllMutation = useDeleteAllPlacementsForRadar()
 * const count = await deleteAllMutation.mutateAsync('my-radar')
 */
export function useDeleteAllPlacementsForRadar() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (radarId: string) => deleteAllPlacementsForRadar(radarId),
    onSuccess: (_, radarId) => {
      queryClient.invalidateQueries({ queryKey: radarPlacementKeys.all })
      queryClient.invalidateQueries({
        queryKey: technologyKeys.withPlacements(radarId),
      })
    },
  })
}

// ============================================================================
// RE-EXPORTS
// ============================================================================

// Re-export types for convenience
export type { RadarPlacementFilters } from '@/lib/radar-placement-service'
