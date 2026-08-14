/**
 * @file useTechnologies.ts
 * @description TanStack Query hooks for Technologies entity
 *
 * Technologies are radar entries aggregated across all radars.
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { useQuery } from '@tanstack/react-query'
import { technologyKeys } from '@/lib/query-keys'
import {
  getTechnologies,
  getAllTechnologyTags,
  getAllQuadrants,
  type TechnologyFilters,
} from '@/lib/technologies'

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all technologies across radars with optional filters
 *
 * @example
 * const { data: technologies, isLoading } = useTechnologies({ ring: 'Adopt' })
 */
export function useTechnologies(filters?: TechnologyFilters) {
  return useQuery({
    queryKey: technologyKeys.list(filters),
    queryFn: () => getTechnologies(filters),
  })
}

/**
 * Fetch all unique technology tags
 *
 * @example
 * const { data: tags } = useTechnologyTags()
 */
export function useTechnologyTags() {
  return useQuery({
    queryKey: [...technologyKeys.all, 'tags'] as const,
    queryFn: getAllTechnologyTags,
    staleTime: 10 * 60 * 1000, // Tags change infrequently
  })
}

/**
 * Fetch all quadrants
 *
 * @example
 * const { data: quadrants } = useQuadrants()
 */
export function useQuadrants() {
  return useQuery({
    queryKey: [...technologyKeys.all, 'quadrants'] as const,
    queryFn: getAllQuadrants,
    staleTime: 30 * 60 * 1000, // Quadrants rarely change
  })
}
