/**
 * @file useUseCases.ts
 * @description TanStack Query hooks for Use Cases entity
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCaseKeys } from '@/lib/query-keys'
import {
  getUseCases,
  getUseCaseById,
  createUseCase,
  updateUseCase,
  deleteUseCase,
} from '@/lib/use-cases'
import type { UseCase } from '@/lib/types'

/**
 * GRAPH-058 note: the mutation hooks below have no consumer today. If one is
 * added, route it through `library-entity-mutation-outcome.ts` rather than
 * calling the service directly — the service requires an acknowledged graph
 * handoff and throws when it is lost, and a bare `onError` would report an
 * already-committed Firestore write as a failed save.
 */

/** UseCase status type */
type UseCaseStatus = UseCase['status']

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all use cases
 */
export function useUseCases() {
  return useQuery({
    queryKey: useCaseKeys.lists(),
    queryFn: getUseCases,
  })
}

/**
 * Fetch a single use case by ID
 */
export function useUseCase(id: string | undefined) {
  return useQuery({
    queryKey: useCaseKeys.detail(id!),
    queryFn: () => getUseCaseById(id!),
    enabled: !!id,
  })
}

/**
 * Fetch use cases organized for Kanban board
 */
export function useUseCasesKanban() {
  return useQuery({
    queryKey: [...useCaseKeys.lists(), 'kanban'] as const,
    queryFn: async () => {
      const useCases = await getUseCases()
      const grouped: Record<UseCaseStatus, UseCase[]> = {
        Proposed: [],
        'In Progress': [],
        Implemented: [],
        Archived: [],
      }
      useCases.forEach((uc) => {
        if (grouped[uc.status]) {
          grouped[uc.status].push(uc)
        }
      })
      return grouped
    },
    staleTime: 30 * 1000,
  })
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Create a new use case
 */
export function useCreateUseCase() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: Omit<UseCase, 'id' | 'createdAt' | 'updatedAt'>) =>
      createUseCase(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: useCaseKeys.all })
    },
  })
}

/**
 * Update a use case with optimistic update
 */
export function useUpdateUseCase() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<UseCase>) =>
      updateUseCase(id, data),
    onMutate: async ({ id, ...data }) => {
      await queryClient.cancelQueries({ queryKey: useCaseKeys.detail(id) })

      const previousUseCase = queryClient.getQueryData<UseCase>(
        useCaseKeys.detail(id)
      )

      if (previousUseCase) {
        queryClient.setQueryData(useCaseKeys.detail(id), {
          ...previousUseCase,
          ...data,
          updatedAt: Date.now(),
        })
      }

      return { previousUseCase }
    },
    onError: (_err, { id }, context) => {
      if (context?.previousUseCase) {
        queryClient.setQueryData(useCaseKeys.detail(id), context.previousUseCase)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: useCaseKeys.all })
    },
  })
}

/**
 * Delete a use case
 */
export function useDeleteUseCase() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteUseCase(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: useCaseKeys.all })
    },
  })
}

/**
 * Update use case status (for Kanban)
 */
export function useUpdateUseCaseStatus() {
  const updateMutation = useUpdateUseCase()

  return {
    ...updateMutation,
    mutate: (id: string, status: UseCaseStatus) =>
      updateMutation.mutate({ id, status }),
    mutateAsync: (id: string, status: UseCaseStatus) =>
      updateMutation.mutateAsync({ id, status }),
  }
}
