/**
 * @file useLikeInsight.ts
 * @description TanStack Query mutation for toggling an insight's `liked`
 * state via the A.1 idempotent endpoints.
 *
 * Optimistic-UI shape:
 *
 *   1. The component calls `mutate({ insightId, liked: true })`.
 *   2. `onMutate` flips `liked` on the cached row immediately so the row
 *      visually re-renders before the network call lands. Snapshot the
 *      prior cache for rollback.
 *   3. The network call hits `POST /api/impulse/briefing/like` (when
 *      `liked: true`) or `DELETE` (when `liked: false`). The endpoint is
 *      idempotent — see A.1 contract: prior-state read + SET in one
 *      transaction, no double-write on retry.
 *   4. On 4xx / 5xx, `onError` restores the snapshot. The rate-limit 429
 *      bubbles up as an `Error` whose `message` contains "Rate limit" —
 *      callers can pattern-match if they want a soft toast.
 *   5. `onSettled` invalidates `briefingKeys.insights()` and
 *      `briefingKeys.detail(insightId)` so the server's authoritative
 *      `liked` state (and any side-effect fields like `likedAt`) refresh
 *      asynchronously.
 *
 * Why a single hook for both directions: like/unlike is the same React
 * intention from the caller's perspective ("set liked to X"). Splitting
 * into useLike + useUnlike doubles boilerplate without paying off — the
 * underlying HTTP verb is just a `targetLiked` boolean.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { briefingKeys, type BriefingData } from '@/hooks/useBriefing';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useLikeInsight');

interface LikeMutationInput {
  insightId: string;
  liked: boolean;
}

interface LikeMutationContext {
  /** Cached `briefingKeys.insights()` snapshot for rollback. */
  previousList: BriefingData | undefined;
}

async function likeRequest({ insightId, liked }: LikeMutationInput): Promise<void> {
  const response = await fetchWithAuth('/api/impulse/briefing/like', {
    method: liked ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ insightId }),
  });
  if (!response.ok) {
    // Surface 429 specifically so consumers can show a calm toast instead
    // of treating it as a generic failure. Body might not be JSON — guard.
    if (response.status === 429) {
      throw new Error('Rate limit exceeded — slow down');
    }
    const text = await response.text().catch(() => '');
    throw new Error(`Like request failed (${response.status}): ${text || response.statusText}`);
  }
}

/**
 * Patch the cached briefing list to reflect a like state change. Returns
 * `previousList` so `onError` can roll back to the pre-mutation snapshot.
 */
function patchListCache(qc: QueryClient, uid: string, insightId: string, liked: boolean): BriefingData | undefined {
  const previousList = qc.getQueryData<BriefingData>(briefingKeys.insights(uid));
  if (!previousList) return undefined;

  qc.setQueryData<BriefingData>(briefingKeys.insights(uid), {
    ...previousList,
    insights: previousList.insights.map((insight) => (insight.id === insightId ? { ...insight, liked } : insight)),
  });

  return previousList;
}

export function useLikeInsight() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const uid = user?.uid ?? 'anonymous';

  return useMutation<void, Error, LikeMutationInput, LikeMutationContext>({
    mutationFn: likeRequest,
    onMutate: async ({ insightId, liked }) => {
      // Cancel any in-flight refetch so the optimistic patch isn't
      // immediately overwritten by stale data.
      await queryClient.cancelQueries({ queryKey: briefingKeys.insights(uid) });
      const previousList = patchListCache(queryClient, uid, insightId, liked);
      return { previousList };
    },
    onError: (error, variables, context) => {
      log.warn('like mutation failed, rolling back cache', {
        insightId: variables.insightId,
        liked: variables.liked,
        error: error.message,
      });
      if (context?.previousList) {
        queryClient.setQueryData(briefingKeys.insights(uid), context.previousList);
      }
    },
    onSettled: (_data, _error, variables) => {
      // Refresh both surfaces — the list and the detail page may render
      // different fields (`liked`, `likedAt`) that need server truth.
      queryClient.invalidateQueries({ queryKey: briefingKeys.insights(uid) });
      queryClient.invalidateQueries({ queryKey: briefingKeys.detail(uid, variables.insightId) });
    },
  });
}
