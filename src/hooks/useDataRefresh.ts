/**
 * @file hooks/useDataRefresh.ts
 * @description React hook for listening to data refresh events.
 *
 * @example
 * // In a page component:
 * useDataRefresh(['companies', 'relations'], () => {
 *   loadCompanies();
 * });
 */

'use client';

import { useEffect, useCallback, useRef, useMemo } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useDataRefresh');
import {
  subscribeToDataRefresh,
  matchesEntityTypes,
  type EntityTypeForRefresh,
} from '@/lib/events/data-refresh';

interface UseDataRefreshOptions {
  /** Debounce time in milliseconds (default: 300ms) */
  debounce?: number;
  /** Only refresh if component is visible */
  onlyWhenVisible?: boolean;
}

/**
 * Hook to listen for data refresh events and trigger a callback.
 *
 * @param entityTypes - Entity types to listen for
 * @param onRefresh - Callback to execute when a matching refresh event occurs
 * @param options - Optional configuration
 */
export function useDataRefresh(
  entityTypes: EntityTypeForRefresh[],
  onRefresh: () => void | Promise<void>,
  options: UseDataRefreshOptions = {}
): void {
  const { debounce = 300, onlyWhenVisible = false } = options;

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastRefreshRef = useRef<number>(0);

  // Use ref to avoid recreating the callback
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  // Memoize entityTypes to prevent effect re-runs on every render
  // This is crucial because ['documents'] !== ['documents'] (reference comparison)
  const stableEntityTypes = useMemo(
    () => entityTypes,
    // Use JSON string as dependency to compare by value, not reference
     
    [JSON.stringify(entityTypes)]
  );

  const handleRefresh = useCallback(() => {
    const now = Date.now();

    // Skip if we just refreshed (debounce)
    if (now - lastRefreshRef.current < debounce) {
      return;
    }

    // Skip if only refresh when visible and document is hidden
    if (onlyWhenVisible && typeof document !== 'undefined' && document.hidden) {
      return;
    }

    // Clear any pending timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Debounce the refresh
    timeoutRef.current = setTimeout(() => {
      lastRefreshRef.current = Date.now();
      onRefreshRef.current();
    }, debounce);
  }, [debounce, onlyWhenVisible]);

  useEffect(() => {
    const unsubscribe = subscribeToDataRefresh((event) => {
      if (matchesEntityTypes(event, stableEntityTypes)) {
        log.debug('Matched refresh event', { entityTypes: event.entityTypes });
        handleRefresh();
      }
    });

    return () => {
      unsubscribe();
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [stableEntityTypes, handleRefresh]);
}

/**
 * Hook to trigger a data refresh manually.
 * Returns a function that emits the refresh event.
 */
export { emitDataRefresh } from '@/lib/events/data-refresh';
