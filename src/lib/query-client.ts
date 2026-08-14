'use client';

import { QueryClient } from '@tanstack/react-query';

/**
 * Create a new QueryClient instance with optimized defaults for the Innovation Platform.
 *
 * Configuration rationale:
 * - staleTime: 5 minutes - Dashboard and entity data doesn't need real-time updates
 * - gcTime: 10 minutes - Keep data in cache longer for instant back-navigation
 * - refetchOnWindowFocus: false - Prevents jarring refetches when switching windows
 * - retry: 1 - One retry is enough, more delays error display
 */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data stays fresh for 5 minutes - good balance for dashboard/entities
        staleTime: 5 * 60 * 1000,
        // Keep unused data in cache for 10 minutes
        gcTime: 10 * 60 * 1000,
        // Don't refetch when window regains focus (prevents jarring UX)
        refetchOnWindowFocus: false,
        // Only retry once on failure
        retry: 1,
        // NOTE: refetchOnMount is intentionally left at its TanStack default
        // (refetch-on-mount-if-stale). Forcing it to `false` suppressed the
        // stale refetch entirely, so a query fetched exactly once per session
        // and the per-hook/global staleTime (5m) was dead — e.g. a list stayed
        // stale after a mutation on another page. The default respects staleTime:
        // fresh (<5m) data does NOT refetch on mount; only stale data does, so
        // this does not add polling.
      },
      mutations: {
        // Retry mutations once
        retry: 1,
      },
    },
  });
}

// Browser: create a singleton that persists across re-renders
let browserQueryClient: QueryClient | undefined = undefined;

/**
 * Get or create a QueryClient instance.
 *
 * - Server: Always creates a new instance (no sharing between requests)
 * - Browser: Uses a singleton pattern for persistence
 */
export function getQueryClient() {
  if (typeof window === 'undefined') {
    // Server: always make a new query client
    return makeQueryClient();
  } else {
    // Browser: use singleton pattern
    if (!browserQueryClient) {
      browserQueryClient = makeQueryClient();
    }
    return browserQueryClient;
  }
}
