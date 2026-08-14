/**
 * @file useDismissInsight.ts
 * @description TanStack Query mutation for dismissing an insight via the
 * A.2 idempotent endpoint.
 *
 * Optimistic-UI shape: when the user dismisses a row, remove it from the
 * cached `briefingKeys.insights()` list *immediately* so the row fades
 * out before the network call lands. The snapshot is held for rollback
 * and is also returned via `data` so the caller can drive an undo
 * snackbar (Chunk 2's row + Chunk 5's bulk both lean on this).
 *
 * The endpoint itself is idempotent: re-dismissing an already-consumed
 * insight is a no-op at the DB layer and returns `changed: false`. We
 * still patch the cache because the UI source of truth for "is this row
 * visible" lives client-side until the next refetch.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { briefingKeys, type BriefingData, type BriefingInsight } from '@/hooks/useBriefing';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useDismissInsight');

interface DismissMutationInput {
  insightId: string;
}

interface DismissMutationContext {
  /** Cached list before the optimistic remove — for rollback. */
  previousList: BriefingData | undefined;
  /**
   * The insight that was dismissed, lifted from the cache before removal.
   * Surfaces to the caller via the mutation's `data` so the undo snackbar
   * can re-insert it on click without a refetch round-trip.
   */
  dismissedInsight: BriefingInsight | undefined;
}

async function dismissRequest({ insightId }: DismissMutationInput): Promise<void> {
  const response = await fetchWithAuth('/api/impulse/briefing/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ insightId }),
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limit exceeded — slow down');
    }
    const text = await response.text().catch(() => '');
    throw new Error(`Dismiss request failed (${response.status}): ${text || response.statusText}`);
  }
}

export function useDismissInsight() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const uid = user?.uid ?? 'anonymous';

  return useMutation<void, Error, DismissMutationInput, DismissMutationContext>({
    mutationFn: dismissRequest,
    onMutate: async ({ insightId }) => {
      await queryClient.cancelQueries({ queryKey: briefingKeys.insights(uid) });
      const previousList = queryClient.getQueryData<BriefingData>(briefingKeys.insights(uid));
      const dismissedInsight = previousList?.insights.find((i) => i.id === insightId);

      if (previousList) {
        queryClient.setQueryData<BriefingData>(briefingKeys.insights(uid), {
          ...previousList,
          insights: previousList.insights.filter((i) => i.id !== insightId),
        });
      }

      return { previousList, dismissedInsight };
    },
    onError: (error, variables, context) => {
      log.warn('dismiss mutation failed, rolling back cache', {
        insightId: variables.insightId,
        error: error.message,
      });
      if (context?.previousList) {
        queryClient.setQueryData(briefingKeys.insights(uid), context.previousList);
      }
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: briefingKeys.insights(uid) });
      queryClient.invalidateQueries({ queryKey: briefingKeys.detail(uid, variables.insightId) });
    },
  });
}
