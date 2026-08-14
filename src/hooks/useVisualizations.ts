/**
 * @file hooks/useVisualizations.ts
 * @description TanStack Query hooks for visualizations (list, detail, mutations)
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import type { Visualization, VisualizationWithReferences } from '@/lib/schemas/visualization';

export type VisualizationDetailResult =
  | { status: 'found'; visualization: VisualizationWithReferences }
  | { status: 'not-found' };

export type VisualizationFetchFailureKind = 'auth' | 'service' | 'network' | 'protocol';

/** A non-absence failure from the authenticated visualization detail read. */
export class VisualizationFetchError extends Error {
  constructor(
    message: string,
    public readonly kind: VisualizationFetchFailureKind,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'VisualizationFetchError';
  }
}

// ============================================================================
// QUERY KEY FACTORY
// ============================================================================

export const visualizationKeys = {
  all: ['visualizations'] as const,
  list: () => [...visualizationKeys.all, 'list'] as const,
  detail: (id: string) => [...visualizationKeys.all, 'detail', id] as const,
};

// ============================================================================
// FETCH FUNCTIONS
// ============================================================================

async function fetchVisualizations(): Promise<Visualization[]> {
  const response = await fetchWithAuth('/api/visualizations');
  if (!response.ok) throw new Error(`Failed to fetch visualizations: ${response.status}`);
  const data = await response.json();
  return data.visualizations ?? [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function fetchVisualization(id: string): Promise<VisualizationDetailResult> {
  let response: Response;
  try {
    response = await fetchWithAuth(`/api/visualizations/${id}`);
  } catch {
    throw new VisualizationFetchError('Visualization request is unavailable', 'network');
  }

  if (!response.ok && response.status !== 404) {
    const kind: VisualizationFetchFailureKind = response.status === 401 || response.status === 403 ? 'auth' : 'service';
    throw new VisualizationFetchError('Visualization request failed', kind, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VisualizationFetchError('Visualization response was invalid', 'protocol', response.status);
  }

  if (response.status === 404 && isObject(payload) && payload.status === 'not-found') {
    return { status: 'not-found' };
  }

  if (!response.ok) {
    throw new VisualizationFetchError('Visualization response was invalid', 'protocol', response.status);
  }

  if (!isObject(payload) || payload.status !== 'found' || !isObject(payload.visualization)) {
    throw new VisualizationFetchError('Visualization response was invalid', 'protocol', response.status);
  }

  return {
    status: 'found',
    visualization: payload.visualization as VisualizationWithReferences,
  };
}

async function apiDeleteVisualization(id: string): Promise<void> {
  const response = await fetchWithAuth(`/api/visualizations/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(`Failed to delete visualization: ${response.status}`);
}

async function apiUpdateVisualization(
  id: string,
  data: { shared?: boolean; title?: string; liked?: boolean | null }
): Promise<void> {
  const response = await fetchWithAuth(`/api/visualizations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Failed to update visualization: ${response.status}`);
}

async function apiBulkDeleteVisualizations(ids: string[]): Promise<void> {
  const response = await fetchWithAuth('/api/visualizations/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw new Error(`Failed to bulk delete: ${response.status}`);
}

// ============================================================================
// HOOKS
// ============================================================================

export function useVisualizations() {
  return useQuery({
    queryKey: visualizationKeys.list(),
    queryFn: fetchVisualizations,
    staleTime: 2 * 60 * 1000,
  });
}

export function useVisualization(id: string) {
  return useQuery({
    queryKey: visualizationKeys.detail(id),
    queryFn: () => fetchVisualization(id),
    staleTime: 30 * 1000,
    enabled: !!id,
  });
}

export function useUpdateVisualization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { shared?: boolean; title?: string; liked?: boolean | null } }) =>
      apiUpdateVisualization(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: visualizationKeys.all });
    },
  });
}

/**
 * Like / dislike toggle for a visualization, with optimistic cache
 * patching so the row's thumbs-up / thumbs-down state flips before the
 * server round-trip lands.
 *
 *   - `liked: true`  → thumbs-up
 *   - `liked: false` → thumbs-down
 *   - `liked: null`  → clear the rating (toggling an active button off)
 *
 * The list query is the canonical cache key the table renders against —
 * we patch the matching row in place rather than invalidating, so the
 * UI doesn't flicker between optimistic and refetched states.
 */
export function useLikeVisualization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, liked }: { id: string; liked: boolean | null }) => apiUpdateVisualization(id, { liked }),
    onMutate: async ({ id, liked }) => {
      const key = visualizationKeys.list();
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Visualization[]>(key);
      if (previous) {
        queryClient.setQueryData<Visualization[]>(
          key,
          previous.map((v) =>
            v.id === id
              ? // Drop the field entirely when the caller clears the
                // rating so the row's UI reflects "no opinion" instead
                // of an explicit `false` (which would highlight the
                // thumbs-down).
                liked === null
                ? (Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'liked')) as Visualization)
                : { ...v, liked }
              : v
          )
        );
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(visualizationKeys.list(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: visualizationKeys.all });
    },
  });
}

export function useDeleteVisualization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: apiDeleteVisualization,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: visualizationKeys.all });
    },
  });
}

export function useBulkDeleteVisualizations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: apiBulkDeleteVisualizations,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: visualizationKeys.all });
    },
  });
}
