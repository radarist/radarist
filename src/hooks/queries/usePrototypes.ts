/**
 * @file usePrototypes.ts
 * @description TanStack Query hooks for Prototypes entity
 *
 * Provides data fetching and mutations with optimistic updates.
 * Includes special support for Kanban board operations.
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { prototypeKeys } from '@/lib/query-keys'
import {
  getPrototypes,
  getPrototypeById,
  createPrototype,
  updatePrototype,
  deletePrototype,
  getPrototypesByStatus,
} from '@/lib/prototypes'
import type { Prototype, PrototypeStatus } from '@/lib/types'

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
 * Fetch all prototypes
 *
 * @example
 * const { data: prototypes, isLoading } = usePrototypes()
 */
export function usePrototypes() {
  return useQuery({
    queryKey: prototypeKeys.lists(),
    queryFn: getPrototypes,
  })
}

/**
 * Fetch a single prototype by ID
 *
 * @example
 * const { data: prototype } = usePrototype(prototypeId)
 */
export function usePrototype(id: string | undefined) {
  return useQuery({
    queryKey: prototypeKeys.detail(id!),
    queryFn: () => getPrototypeById(id!),
    enabled: !!id,
  })
}

/**
 * Fetch prototypes by status (for Kanban columns)
 *
 * @example
 * const { data: inProgress } = usePrototypesByStatus('In Progress')
 */
export function usePrototypesByStatus(status: PrototypeStatus) {
  return useQuery({
    queryKey: [...prototypeKeys.lists(), { status }] as const,
    queryFn: () => getPrototypesByStatus(status),
  })
}

/**
 * Fetch prototypes organized for Kanban board
 * Returns data grouped by status for efficient rendering
 */
export function usePrototypesKanban() {
  return useQuery({
    queryKey: prototypeKeys.kanban(),
    queryFn: async () => {
      const prototypes = await getPrototypes()
      // Group by status
      const grouped: Record<PrototypeStatus, Prototype[]> = {
        Ideation: [],
        'In Development': [],
        'Demo Ready': [],
        Delivered: [],
        Archived: [],
      }
      prototypes.forEach((p) => {
        if (grouped[p.status]) {
          grouped[p.status].push(p)
        }
      })
      return grouped
    },
    staleTime: 30 * 1000, // 30 seconds - Kanban needs fresher data
  })
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Create a new prototype
 */
export function useCreatePrototype() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: Omit<Prototype, 'id' | 'createdAt' | 'updatedAt'>) =>
      createPrototype(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: prototypeKeys.all })
    },
  })
}

/**
 * Update a prototype with optimistic update
 * Especially useful for Kanban drag-and-drop status changes
 */
export function useUpdatePrototype() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Prototype>) =>
      updatePrototype(id, data),
    onMutate: async ({ id, ...data }) => {
      await queryClient.cancelQueries({ queryKey: prototypeKeys.detail(id) })
      await queryClient.cancelQueries({ queryKey: prototypeKeys.kanban() })

      const previousPrototype = queryClient.getQueryData<Prototype>(
        prototypeKeys.detail(id)
      )
      const previousKanban = queryClient.getQueryData<Record<string, Prototype[]>>(
        prototypeKeys.kanban()
      )

      // Optimistically update detail
      if (previousPrototype) {
        queryClient.setQueryData(prototypeKeys.detail(id), {
          ...previousPrototype,
          ...data,
          updatedAt: Date.now(),
        })
      }

      // Optimistically update Kanban if status changed
      if (previousKanban && data.status && previousPrototype) {
        const oldStatus = previousPrototype.status
        const newStatus = data.status

        if (oldStatus !== newStatus) {
          const newKanban = { ...previousKanban }
          // Remove from old column
          newKanban[oldStatus] = newKanban[oldStatus]?.filter((p) => p.id !== id) || []
          // Add to new column
          newKanban[newStatus] = [
            ...(newKanban[newStatus] || []),
            { ...previousPrototype, ...data, updatedAt: Date.now() },
          ]
          queryClient.setQueryData(prototypeKeys.kanban(), newKanban)
        }
      }

      return { previousPrototype, previousKanban }
    },
    onError: (_err, { id }, context) => {
      if (context?.previousPrototype) {
        queryClient.setQueryData(prototypeKeys.detail(id), context.previousPrototype)
      }
      if (context?.previousKanban) {
        queryClient.setQueryData(prototypeKeys.kanban(), context.previousKanban)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: prototypeKeys.all })
    },
  })
}

/**
 * Delete a prototype
 */
export function useDeletePrototype() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deletePrototype(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: prototypeKeys.all })
    },
  })
}

/**
 * Optimistic status update helper for Kanban drag-and-drop
 * This is a specialized hook for the most common Kanban operation
 */
export function useUpdatePrototypeStatus() {
  const updateMutation = useUpdatePrototype()

  return {
    ...updateMutation,
    mutate: (id: string, status: PrototypeStatus) =>
      updateMutation.mutate({ id, status }),
    mutateAsync: (id: string, status: PrototypeStatus) =>
      updateMutation.mutateAsync({ id, status }),
  }
}
