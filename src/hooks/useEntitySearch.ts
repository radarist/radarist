/**
 * @file hooks/useEntitySearch.ts
 * @description Hook for searching entities across the platform
 *
 * Provides a reusable function to search for entities by query,
 * used by RelationPicker and other components that need entity search.
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

import { useCallback } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useEntitySearch');
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import type { EntityType } from '@/lib/types';
import type { EntityOption } from '@/components/sheets/tabs/RelationPicker';

interface SearchResponse {
  success: boolean;
  data: EntityOption[];
  count: number;
  error?: string;
}

/**
 * Hook that provides an entity search function
 *
 * @returns searchEntities function that can be passed to RelationPicker
 *
 * @example
 * ```tsx
 * const { searchEntities } = useEntitySearch();
 *
 * <RelationsTab
 *   onSearchEntities={searchEntities}
 *   // ...other props
 * />
 * ```
 */
export function useEntitySearch() {
  const searchEntities = useCallback(
    async (query: string, entityType?: EntityType): Promise<EntityOption[]> => {
      if (!query.trim()) {
        return [];
      }

      try {
        const params = new URLSearchParams({ q: query });
        if (entityType) {
          params.set('type', entityType);
        }

        const response = await fetchWithAuth(`/api/search?${params.toString()}`);
        const data: SearchResponse = await response.json();

        if (!data.success) {
          log.error('Search failed', undefined, { error: data.error });
          return [];
        }

        return data.data;
      } catch (error) {
        log.error('Error searching entities', error instanceof Error ? error : new Error(String(error)));
        return [];
      }
    },
    []
  );

  return { searchEntities };
}

/**
 * Standalone function for searching entities (non-hook version)
 * Use this when you need to search outside of a React component
 */
export async function searchEntities(
  query: string,
  entityType?: EntityType
): Promise<EntityOption[]> {
  if (!query.trim()) {
    return [];
  }

  try {
    const params = new URLSearchParams({ q: query });
    if (entityType) {
      params.set('type', entityType);
    }

    const response = await fetchWithAuth(`/api/search?${params.toString()}`);
    const data: SearchResponse = await response.json();

    if (!data.success) {
      log.error('Search failed', undefined, { error: data.error });
      return [];
    }

    return data.data;
  } catch (error) {
    log.error('Error searching entities', error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}
