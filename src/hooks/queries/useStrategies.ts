/**
 * @file useStrategies.ts
 * @description TanStack Query hooks for Strategies entity
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { strategyKeys } from '@/lib/query-keys'
import {
  getStrategies,
  getStrategyById,
  createStrategy,
  updateStrategy,
  deleteStrategy,
} from '@/lib/strategies'
import type { Strategy } from '@/lib/types'

/**
 * GRAPH-058 note: the mutation hooks below have no consumer today. If one is
 * added, route it through `library-entity-mutation-outcome.ts` rather than
 * calling the service directly — the service requires an acknowledged graph
 * handoff and throws when it is lost, and a bare `onError` would report an
 * already-committed Firestore write as a failed save.
 */

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all strategies
 */
export function useStrategies() {
  return useQuery({
    queryKey: strategyKeys.lists(),
    queryFn: getStrategies,
  })
}

/**
 * Fetch a single strategy by ID
 */
export function useStrategy(id: string | undefined) {
  return useQuery({
    queryKey: strategyKeys.detail(id!),
    queryFn: () => getStrategyById(id!),
    enabled: !!id,
  })
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Create a new strategy
 */
export function useCreateStrategy() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: Omit<Strategy, 'id' | 'createdAt' | 'updatedAt'>) =>
      createStrategy(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: strategyKeys.all })
    },
  })
}

/**
 * Update a strategy with optimistic update
 */
export function useUpdateStrategy() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Strategy>) =>
      updateStrategy(id, data),
    onMutate: async ({ id, ...data }) => {
      await queryClient.cancelQueries({ queryKey: strategyKeys.detail(id) })

      const previousStrategy = queryClient.getQueryData<Strategy>(
        strategyKeys.detail(id)
      )

      if (previousStrategy) {
        queryClient.setQueryData(strategyKeys.detail(id), {
          ...previousStrategy,
          ...data,
          updatedAt: Date.now(),
        })
      }

      return { previousStrategy }
    },
    onError: (_err, { id }, context) => {
      if (context?.previousStrategy) {
        queryClient.setQueryData(strategyKeys.detail(id), context.previousStrategy)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: strategyKeys.all })
    },
  })
}

/**
 * Delete a strategy
 */
export function useDeleteStrategy() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteStrategy(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: strategyKeys.all })
    },
  })
}
