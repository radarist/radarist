/**
 * @file useUndismissInsight.ts
 * @description TanStack Query mutation for the dismiss undo path
 * (A.2 — `DELETE /api/impulse/briefing/dismiss`).
 *
 * Optimistic-UI shape: re-insert the previously-dismissed insight into
 * the cached list. The caller passes the full insight object (lifted
 * from `useDismissInsight`'s `dismissedInsight` context) so we can
 * re-create the row without a refetch.
 *
 * Position: the un-dismissed insight is prepended to the list since
 * `getInsightsForUser` orders by `createdAt DESC` and the undo intent is
 * "put this back where it was visually." A subsequent invalidate
 * refetches the authoritative ordering.
 *
 * Idempotency: re-undismissing a non-consumed insight returns
 * `{ noop: true }` server-side with HTTP 200 — the cache patch is a
 * no-op too (filter dedups by id before prepend).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { briefingKeys, type BriefingData, type BriefingInsight } from '@/hooks/useBriefing';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useUndismissInsight');

interface UndismissMutationInput {
  /** The insight to restore. Passed in full so we can patch the cache. */
  insight: BriefingInsight;
}

interface UndismissMutationContext {
  previousList: BriefingData | undefined;
}

async function undismissRequest({ insight }: UndismissMutationInput): Promise<void> {
  const response = await fetchWithAuth('/api/impulse/briefing/dismiss', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ insightId: insight.id }),
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limit exceeded — slow down');
    }
    const text = await response.text().catch(() => '');
    throw new Error(`Undismiss request failed (${response.status}): ${text || response.statusText}`);
  }
}

export function useUndismissInsight() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const uid = user?.uid ?? 'anonymous';

  return useMutation<void, Error, UndismissMutationInput, UndismissMutationContext>({
    mutationFn: undismissRequest,
    onMutate: async ({ insight }) => {
      await queryClient.cancelQueries({ queryKey: briefingKeys.insights(uid) });
      const previousList = queryClient.getQueryData<BriefingData>(briefingKeys.insights(uid));

      if (previousList) {
        // Dedup by id before prepend — guards against a double-fire from
        // a frantic undo click and against the "list already contains
        // this insight" race when the refetch lands between mutate calls.
        const withoutDup = previousList.insights.filter((i) => i.id !== insight.id);
        queryClient.setQueryData<BriefingData>(briefingKeys.insights(uid), {
          ...previousList,
          insights: [insight, ...withoutDup],
        });
      }

      return { previousList };
    },
    onError: (error, variables, context) => {
      log.warn('undismiss mutation failed, rolling back cache', {
        insightId: variables.insight.id,
        error: error.message,
      });
      if (context?.previousList) {
        queryClient.setQueryData(briefingKeys.insights(uid), context.previousList);
      }
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: briefingKeys.insights(uid) });
      queryClient.invalidateQueries({ queryKey: briefingKeys.detail(uid, variables.insight.id) });
    },
  });
}
