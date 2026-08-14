/**
 * @file useTechnologiesDecoupled.ts
 * @description TanStack Query hooks for decoupled Technology entity (Phase 1)
 *
 * These hooks work with the new Technology model (facts) separate from
 * RadarPlacement (opinions). Use these for the new architecture.
 *
 * Legacy hooks in useTechnologies.ts work with RadarEntry model.
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { technologyKeys } from '@/lib/query-keys';
import {
  getTechnologies,
  getTechnologyById,
  getTechnologyBySlug,
  createTechnology,
  updateTechnology,
  deleteTechnology,
  deleteTechnologyWithPlacements,
  getAllTechnologyTags,
  getAllTechnologyCategories,
  searchTechnologies,
  linkCompanyToTechnology,
  unlinkCompanyFromTechnology,
  linkUseCaseToTechnology,
  unlinkUseCaseFromTechnology,
  type TechnologyFilters,
} from '@/lib/technology-service';
import type { Technology, CreateTechnologyInput } from '@/lib/types';

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch all technologies with optional filters
 *
 * @example
 * const { data: technologies, isLoading } = useDecoupledTechnologies({ category: 'framework' })
 */
export function useDecoupledTechnologies(filters?: TechnologyFilters) {
  return useQuery({
    queryKey: technologyKeys.list(filters),
    queryFn: () => getTechnologies(filters),
  });
}

/**
 * Fetch a single technology by ID
 *
 * @example
 * const { data: technology, isLoading } = useDecoupledTechnology('tech-123')
 */
export function useDecoupledTechnology(id: string | undefined) {
  return useQuery({
    queryKey: technologyKeys.detail(id!),
    queryFn: () => getTechnologyById(id!),
    enabled: !!id,
  });
}

/**
 * Fetch a technology by its URL-friendly slug
 *
 * @example
 * const { data: technology } = useTechnologyBySlug('react')
 */
export function useTechnologyBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: technologyKeys.bySlug(slug!),
    queryFn: () => getTechnologyBySlug(slug!),
    enabled: !!slug,
  });
}

/**
 * Search technologies by name with fuzzy matching
 *
 * @example
 * const { data: results } = useTechnologySearch('react', 10)
 */
export function useTechnologySearch(searchTerm: string, limit?: number) {
  return useQuery({
    queryKey: [...technologyKeys.all, 'search', searchTerm, limit] as const,
    queryFn: () => searchTechnologies(searchTerm, limit),
    enabled: searchTerm.length >= 2,
  });
}

/**
 * Fetch all unique tags across all technologies
 *
 * @example
 * const { data: tags } = useDecoupledTechnologyTags()
 */
export function useDecoupledTechnologyTags() {
  return useQuery({
    queryKey: [...technologyKeys.all, 'tags'] as const,
    queryFn: getAllTechnologyTags,
    staleTime: 10 * 60 * 1000, // Tags change infrequently
  });
}

/**
 * Fetch all unique categories across all technologies
 *
 * @example
 * const { data: categories } = useTechnologyCategories()
 */
export function useTechnologyCategories() {
  return useQuery({
    queryKey: [...technologyKeys.all, 'categories'] as const,
    queryFn: getAllTechnologyCategories,
    staleTime: 30 * 60 * 1000, // Categories change rarely
  });
}

// ============================================================================
// MUTATION HOOKS
// ============================================================================

/**
 * Create a new technology with optimistic update
 *
 * @example
 * const createMutation = useCreateDecoupledTechnology()
 * createMutation.mutate({
 *   name: 'React',
 *   description: 'A JavaScript library for building UIs',
 *   category: 'framework',
 *   tags: ['frontend', 'javascript'],
 *   createdBy: 'user-123',
 * })
 */
export function useCreateDecoupledTechnology() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateTechnologyInput) => createTechnology(data),
    onSuccess: () => {
      // Invalidate technologies list to refetch
      queryClient.invalidateQueries({ queryKey: technologyKeys.lists() });
      // Invalidate tags and categories as they might have changed
      queryClient.invalidateQueries({ queryKey: [...technologyKeys.all, 'tags'] });
      queryClient.invalidateQueries({ queryKey: [...technologyKeys.all, 'categories'] });
    },
  });
}

/**
 * Update an existing technology with optimistic update
 *
 * @example
 * const updateMutation = useUpdateDecoupledTechnology()
 * updateMutation.mutate({ id: 'tech-123', description: 'Updated description' })
 */
export function useUpdateDecoupledTechnology() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Omit<Technology, 'id' | 'createdAt' | 'createdBy'>>) =>
      updateTechnology(id, data),
    onMutate: async ({ id, ...data }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: technologyKeys.detail(id) });

      // Snapshot previous value
      const previousTechnology = queryClient.getQueryData<Technology>(technologyKeys.detail(id));

      // Optimistically update the cache
      if (previousTechnology) {
        queryClient.setQueryData(technologyKeys.detail(id), {
          ...previousTechnology,
          ...data,
          updatedAt: Date.now(),
        });
      }

      return { previousTechnology };
    },
    onError: (_err, { id }, context) => {
      // Rollback on error
      if (context?.previousTechnology) {
        queryClient.setQueryData(technologyKeys.detail(id), context.previousTechnology);
      }
    },
    onSettled: (_data, _error, { id }) => {
      // Refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: technologyKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: technologyKeys.lists() });
    },
  });
}

/**
 * Delete a technology (without cascade).
 *
 * @deprecated Use `useDeleteTechnologyWithPlacements` instead. This hook
 * skips the cascade and leaves any existing radar placements pointing at a
 * deleted technology. Kept only because the `index.ts` barrel re-exports it
 * for backwards compatibility; no UI component consumes it. Remove in a
 * future cleanup pass once external consumers no longer depend on the symbol.
 *
 * @example
 * const deleteMutation = useDeleteDecoupledTechnology()
 * deleteMutation.mutate('tech-123') // orphans placements — use cascade variant
 */
export function useDeleteDecoupledTechnology() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteTechnology(id),
    onMutate: async (id) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: technologyKeys.lists() });

      // Snapshot previous value
      const previousTechnologies = queryClient.getQueryData<Technology[]>(technologyKeys.lists());

      // Optimistically remove from list
      if (previousTechnologies) {
        queryClient.setQueryData(
          technologyKeys.lists(),
          previousTechnologies.filter((t) => t.id !== id)
        );
      }

      return { previousTechnologies };
    },
    onError: (_err, _id, context) => {
      // Rollback on error
      if (context?.previousTechnologies) {
        queryClient.setQueryData(technologyKeys.lists(), context.previousTechnologies);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: technologyKeys.all });
    },
  });
}

/**
 * Delete a technology with cascade (removes all radar placements)
 *
 * @example
 * const deleteMutation = useDeleteTechnologyWithPlacements()
 * const placementsDeleted = await deleteMutation.mutateAsync('tech-123')
 */
export function useDeleteTechnologyWithPlacements() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteTechnologyWithPlacements(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: technologyKeys.all });
      // Also invalidate radar placements
      queryClient.invalidateQueries({ queryKey: ['radarPlacements'] });
    },
  });
}

// ============================================================================
// LINKING MUTATIONS
// ============================================================================

/**
 * Link a company to a technology
 *
 * @example
 * const linkMutation = useLinkCompanyToTechnology()
 * linkMutation.mutate({ technologyId: 'tech-123', companyId: 'company-456' })
 */
export function useLinkCompanyToTechnology() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ technologyId, companyId }: { technologyId: string; companyId: string }) =>
      linkCompanyToTechnology(technologyId, companyId),
    onSuccess: (_, { technologyId }) => {
      queryClient.invalidateQueries({ queryKey: technologyKeys.detail(technologyId) });
      queryClient.invalidateQueries({ queryKey: technologyKeys.relations(technologyId) });
    },
  });
}

/**
 * Unlink a company from a technology
 *
 * @example
 * const unlinkMutation = useUnlinkCompanyFromTechnology()
 * unlinkMutation.mutate({ technologyId: 'tech-123', companyId: 'company-456' })
 */
export function useUnlinkCompanyFromTechnology() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ technologyId, companyId }: { technologyId: string; companyId: string }) =>
      unlinkCompanyFromTechnology(technologyId, companyId),
    onSuccess: (_, { technologyId }) => {
      queryClient.invalidateQueries({ queryKey: technologyKeys.detail(technologyId) });
      queryClient.invalidateQueries({ queryKey: technologyKeys.relations(technologyId) });
    },
  });
}

/**
 * Link a use case to a technology
 *
 * @example
 * const linkMutation = useLinkUseCaseToTechnology()
 * linkMutation.mutate({ technologyId: 'tech-123', useCaseId: 'uc-789' })
 */
export function useLinkUseCaseToTechnology() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ technologyId, useCaseId }: { technologyId: string; useCaseId: string }) =>
      linkUseCaseToTechnology(technologyId, useCaseId),
    onSuccess: (_, { technologyId }) => {
      queryClient.invalidateQueries({ queryKey: technologyKeys.detail(technologyId) });
      queryClient.invalidateQueries({ queryKey: technologyKeys.relations(technologyId) });
    },
  });
}

/**
 * Unlink a use case from a technology
 *
 * @example
 * const unlinkMutation = useUnlinkUseCaseFromTechnology()
 * unlinkMutation.mutate({ technologyId: 'tech-123', useCaseId: 'uc-789' })
 */
export function useUnlinkUseCaseFromTechnology() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ technologyId, useCaseId }: { technologyId: string; useCaseId: string }) =>
      unlinkUseCaseFromTechnology(technologyId, useCaseId),
    onSuccess: (_, { technologyId }) => {
      queryClient.invalidateQueries({ queryKey: technologyKeys.detail(technologyId) });
      queryClient.invalidateQueries({ queryKey: technologyKeys.relations(technologyId) });
    },
  });
}
