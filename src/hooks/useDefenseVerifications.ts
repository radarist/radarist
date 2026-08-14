/**
 * @file hooks/useDefenseVerifications.ts
 * @description TanStack Query hook backing the Activity → Jobs page.
 *
 * Mirrors the auth-gating pattern from `useAgentActivity`: queries are disabled
 * until Firebase auth-state restoration completes so `fetchWithAuth` does not
 * ship a stale/missing Authorization header.
 *
 * UX-068 — the Jobs table sorts, searches and paginates on the client, which
 * only makes sense over a window the client actually holds. The route stays
 * cursor-paginated and bounded (`limit` ≤ 100, enforced server-side); this hook
 * accumulates those bounded pages on demand and reports `hasMore` so the table
 * can say plainly when its view is a window rather than the whole ledger.
 */

import { useInfiniteQuery } from '@tanstack/react-query';

import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import type {
  DefenseVerificationKind,
  DefenseVerificationListPage,
  DefenseVerificationRow,
  DefenseVerificationStatus,
} from '@/lib/activity/defense-verification-types';

const STALE_TIME_MS = 30 * 1000;
const REFETCH_INTERVAL_MS = 60 * 1000;

/**
 * Rows fetched per request. Matches the route's maximum `limit`, so a window
 * is one round trip rather than ten, and the bound stays the server's.
 */
export const DEFENSE_VERIFICATION_WINDOW = 100;

const defenseVerificationKeys = {
  all: ['activity', 'defense-verifications'] as const,
  forUser: (uid: string) => [...defenseVerificationKeys.all, uid] as const,
  list: (uid: string, filters: DefenseVerificationsFilterInput) =>
    [...defenseVerificationKeys.forUser(uid), 'list', filters] as const,
};

export interface DefenseVerificationsFilterInput {
  kind?: DefenseVerificationKind;
  status?: DefenseVerificationStatus;
  cursor?: string;
  limit?: number;
}

/** Server-side filters. Changing either restarts pagination from the first page. */
export interface DefenseVerificationJobsFilters {
  kind?: DefenseVerificationKind;
  status?: DefenseVerificationStatus;
}

async function fetchDefenseVerifications(
  filters: DefenseVerificationsFilterInput
): Promise<DefenseVerificationListPage> {
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.status) params.set('status', filters.status);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit) params.set('limit', String(filters.limit));

  const query = params.toString();
  const res = await fetchWithAuth(`/api/activity/defense-verifications${query ? `?${query}` : ''}`);
  if (!res.ok) throw new Error(`Failed to fetch defense verifications: ${res.status}`);
  return (await res.json()) as DefenseVerificationListPage;
}

export interface DefenseVerificationJobsResult {
  jobs: DefenseVerificationRow[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  /** The server has rows beyond the loaded window. */
  hasMore: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
}

/**
 * Loads Background Verification job runs for the Activity → Jobs page.
 *
 * A refetch re-reads every already-loaded page, and a cursor page can shift
 * under a concurrent write, so the flattened rows are de-duplicated by durable
 * JobRun id: the same run must never appear twice just because the ledger moved
 * between two requests.
 */
export function useDefenseVerificationJobs(
  filters: DefenseVerificationJobsFilters = {}
): DefenseVerificationJobsResult {
  const { user, loading } = useAuth();
  const query = useInfiniteQuery({
    queryKey: defenseVerificationKeys.list(user?.uid ?? 'anonymous', {
      ...filters,
      limit: DEFENSE_VERIFICATION_WINDOW,
    }),
    queryFn: ({ pageParam }) =>
      fetchDefenseVerifications({ ...filters, limit: DEFENSE_VERIFICATION_WINDOW, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: DefenseVerificationListPage) => lastPage.nextCursor ?? undefined,
    enabled: !loading && !!user,
    staleTime: STALE_TIME_MS,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const seen = new Set<string>();
  const jobs: DefenseVerificationRow[] = [];
  for (const page of query.data?.pages ?? []) {
    for (const row of page.verifications) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      jobs.push(row);
    }
  }

  return {
    jobs,
    isLoading: query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => void query.fetchNextPage(),
    isLoadingMore: query.isFetchingNextPage,
  };
}
