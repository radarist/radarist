/**
 * @file useCompanies.ts
 * @description TanStack Query hooks for Companies entity
 *
 * Provides data fetching and mutations with:
 * - Automatic caching and background refresh
 * - Optimistic updates for mutations
 * - Type-safe query keys
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { companyKeys } from '@/lib/query-keys'
import {
  getCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
  searchCompanies,
  type CompanyFilters,
} from '@/lib/companies'
import type { Company } from '@/lib/types'

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all companies
 *
 * @example
 * const { data: companies, isLoading, error } = useCompanies()
 */
export function useCompanies(filters?: CompanyFilters) {
  return useQuery({
    queryKey: companyKeys.list(filters),
    queryFn: async () => {
      if (filters && Object.keys(filters).length > 0) {
        return searchCompanies(filters)
      }
      return getCompanies()
    },
  })
}

/**
 * Fetch a single company by ID
 *
 * @example
 * const { data: company, isLoading } = useCompany(companyId)
 */
export function useCompany(id: string | undefined) {
  return useQuery({
    queryKey: companyKeys.detail(id!),
    queryFn: () => getCompanyById(id!),
    enabled: !!id,
  })
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Create a new company with optimistic update
 *
 * @example
 * const createMutation = useCreateCompany()
 * createMutation.mutate({ name: 'Acme Corp', ... })
 */
export function useCreateCompany() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: Omit<Company, 'id' | 'createdAt' | 'updatedAt'>) =>
      createCompany(data),
    onSuccess: () => {
      // Invalidate companies list to refetch
      queryClient.invalidateQueries({ queryKey: companyKeys.lists() })
    },
  })
}

/**
 * Update an existing company with optimistic update
 *
 * @example
 * const updateMutation = useUpdateCompany()
 * updateMutation.mutate({ id: 'abc123', name: 'New Name' })
 */
export function useUpdateCompany() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Company>) =>
      updateCompany(id, data),
    onMutate: async ({ id, ...data }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: companyKeys.detail(id) })

      // Snapshot previous value
      const previousCompany = queryClient.getQueryData<Company>(
        companyKeys.detail(id)
      )

      // Optimistically update the cache
      if (previousCompany) {
        queryClient.setQueryData(companyKeys.detail(id), {
          ...previousCompany,
          ...data,
          updatedAt: Date.now(),
        })
      }

      return { previousCompany }
    },
    onError: (_err, { id }, context) => {
      // Rollback on error
      if (context?.previousCompany) {
        queryClient.setQueryData(companyKeys.detail(id), context.previousCompany)
      }
    },
    onSettled: (_data, _error, { id }) => {
      // Refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: companyKeys.detail(id) })
      queryClient.invalidateQueries({ queryKey: companyKeys.lists() })
    },
  })
}

/**
 * Delete a company
 *
 * @example
 * const deleteMutation = useDeleteCompany()
 * deleteMutation.mutate('company-id')
 */
export function useDeleteCompany() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => deleteCompany(id),
    onMutate: async (id) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: companyKeys.lists() })

      // Snapshot previous value
      const previousCompanies = queryClient.getQueryData<Company[]>(
        companyKeys.lists()
      )

      // Optimistically remove from list
      if (previousCompanies) {
        queryClient.setQueryData(
          companyKeys.lists(),
          previousCompanies.filter((c) => c.id !== id)
        )
      }

      return { previousCompanies }
    },
    onError: (_err, _id, context) => {
      // Rollback on error
      if (context?.previousCompanies) {
        queryClient.setQueryData(companyKeys.lists(), context.previousCompanies)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: companyKeys.all })
    },
  })
}
