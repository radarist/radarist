/**
 * @file useDashboard.ts
 * @description TanStack Query hook for Dashboard data
 *
 * Provides cached, auto-refreshing dashboard data with smart polling
 * that pauses when the tab is inactive.
 *
 * @author Radarist Team
 * @created 2025-12-04
 */

import { useQuery } from '@tanstack/react-query';
import { dashboardKeys } from '@/lib/query-keys';
import { getDashboardData } from '@/lib/dashboard';
import { useAuth } from '@/components/providers/AuthProvider';
import type { DashboardData } from '@/lib/types';

// ============================================================================
// QUERY HOOKS
// ============================================================================

/**
 * Fetch complete dashboard data with automatic refresh
 *
 * Features:
 * - Caches data for 60 seconds (staleTime)
 * - Auto-refreshes every 60 seconds
 * - STOPS polling when tab is inactive (saves Firestore reads)
 * - Instant back-navigation (returns cached data)
 *
 * @example
 * ```tsx
 * const { data, isLoading, error, refetch } = useDashboardData()
 *
 * if (isLoading) return <DashboardSkeleton />
 * if (error) return <ErrorFallback error={error} />
 *
 * return <DashboardOverview data={data} />
 * ```
 */
export function useDashboardData() {
  // AUDIT-019: agent-run reads are scoped to the signed-in user (plus system
  // principals) — gate on auth restoration and key the cache per-uid.
  const { user, loading } = useAuth();
  const uid = user?.uid ?? '';
  const query = useQuery<DashboardData>({
    queryKey: dashboardKeys.data(uid),
    queryFn: () => getDashboardData(uid),
    enabled: !loading && !!user,
    staleTime: 0, // Always refetch when component mounts
    refetchOnMount: 'always', // Always refresh when dashboard opens
    refetchInterval: 60 * 1000, // Poll every 60 seconds
    refetchIntervalInBackground: false, // DON'T poll when tab inactive
    retry: 1, // Only retry once on failure
  });
  // isPending (not TanStack's isLoading = isPending && isFetching): while the
  // auth gate holds the query disabled there is no fetch in flight, but there
  // is also no data — consumers must keep showing the skeleton through that
  // window instead of flashing a blank page (same contract as useInbox).
  return { ...query, isLoading: query.isPending };
}
