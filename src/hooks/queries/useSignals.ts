/**
 * @file useSignals.ts
 * @description TanStack Query hooks for Signals entity
 *
 * Signals are AI-detected innovation signals that need human triage.
 * This includes special hooks for the approval queue.
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { signalKeys } from '@/lib/query-keys'
import {
  getSignals,
  getSignalById,
  getPendingSignals,
  approveSignal,
  rejectSignal,
  getSignalStatistics,
} from '@/lib/signals-client'
import type { Signal } from '@/lib/types'

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all signals
 */
export function useSignals() {
  return useQuery({
    queryKey: signalKeys.lists(),
    queryFn: getSignals,
  })
}

/**
 * Fetch a single signal by ID
 */
export function useSignal(id: string | undefined) {
  return useQuery({
    queryKey: signalKeys.detail(id!),
    queryFn: () => getSignalById(id!),
    enabled: !!id,
  })
}

/**
 * Fetch pending signals for triage queue
 * Uses shorter stale time for fresher data during active triage
 */
export function usePendingSignals(maxResults: number = 50) {
  return useQuery({
    queryKey: signalKeys.pending(),
    queryFn: () => getPendingSignals(maxResults),
    staleTime: 30 * 1000, // 30 seconds - triage needs fresh data
  })
}

/**
 * Fetch signal statistics for dashboard
 */
export function useSignalStatistics() {
  return useQuery({
    queryKey: [...signalKeys.all, 'statistics'] as const,
    queryFn: getSignalStatistics,
  })
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Approve a signal
 * Removes from pending queue optimistically
 */
export function useApproveSignal() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => approveSignal(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: signalKeys.pending() })

      const previousPending = queryClient.getQueryData<Signal[]>(
        signalKeys.pending()
      )

      // Optimistically remove from pending queue
      if (previousPending) {
        queryClient.setQueryData(
          signalKeys.pending(),
          previousPending.filter((s) => s.id !== id)
        )
      }

      return { previousPending }
    },
    onError: (_err, _id, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData(signalKeys.pending(), context.previousPending)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: signalKeys.all })
    },
  })
}

/**
 * Reject a signal
 * Removes from pending queue optimistically
 */
export function useRejectSignal() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectSignal(id, reason),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: signalKeys.pending() })

      const previousPending = queryClient.getQueryData<Signal[]>(
        signalKeys.pending()
      )

      if (previousPending) {
        queryClient.setQueryData(
          signalKeys.pending(),
          previousPending.filter((s) => s.id !== id)
        )
      }

      return { previousPending }
    },
    onError: (_err, _vars, context) => {
      if (context?.previousPending) {
        queryClient.setQueryData(signalKeys.pending(), context.previousPending)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: signalKeys.all })
    },
  })
}
