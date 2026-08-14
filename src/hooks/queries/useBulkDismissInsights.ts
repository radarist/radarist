/**
 * @file useBulkDismissInsights.ts
 * @description TanStack Query mutation for bulk dismiss / undismiss
 * (A.2 — `POST/DELETE /api/impulse/briefing/bulk-dismiss`).
 *
 * Behaviour differs from single-dismiss:
 *
 *   - Caller passes an array of `insightIds` and a direction
 *     (`dismiss: true` or `false`). One hook, both directions, mirroring
 *     `useLikeInsight`'s shape.
 *   - Optimistic cache patch: remove the batch on `dismiss: true`,
 *     prepend on `dismiss: false`. The undismiss path needs the full
 *     insight objects (the caller carries them from the recently-
 *     dismissed snackbar / a local "recently dismissed" cache).
 *   - Per Q3, the route SKIPS preference writes — there's no per-topic
 *     ranking impact to roll back. The undo is purely a `consumed` flag
 *     flip on each row.
 *
 * Batch cap (200) is enforced server-side; client makes no assumption.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { briefingKeys, type BriefingData, type BriefingInsight } from '@/hooks/useBriefing';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useBulkDismissInsights');

type BulkDismissInput = { dismiss: true; insightIds: string[] } | { dismiss: false; insights: BriefingInsight[] };

interface BulkDismissContext {
  previousList: BriefingData | undefined;
  /** For undo-of-bulk-dismiss: the rows we removed so caller can re-insert. */
  removedInsights: BriefingInsight[];
}

async function bulkDismissRequest(input: BulkDismissInput): Promise<void> {
  const insightIds = input.dismiss ? input.insightIds : input.insights.map((i) => i.id);
  const response = await fetchWithAuth('/api/impulse/briefing/bulk-dismiss', {
    method: input.dismiss ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ insightIds }),
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limit exceeded — slow down');
    }
    const text = await response.text().catch(() => '');
    throw new Error(`Bulk-dismiss request failed (${response.status}): ${text || response.statusText}`);
  }
}

export function useBulkDismissInsights() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const uid = user?.uid ?? 'anonymous';

  return useMutation<void, Error, BulkDismissInput, BulkDismissContext>({
    mutationFn: bulkDismissRequest,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: briefingKeys.insights(uid) });
      const previousList = queryClient.getQueryData<BriefingData>(briefingKeys.insights(uid));

      let removedInsights: BriefingInsight[] = [];

      if (previousList) {
        if (input.dismiss) {
          const idSet = new Set(input.insightIds);
          removedInsights = previousList.insights.filter((i) => idSet.has(i.id));
          queryClient.setQueryData<BriefingData>(briefingKeys.insights(uid), {
            ...previousList,
            insights: previousList.insights.filter((i) => !idSet.has(i.id)),
          });
        } else {
          // Undismiss: prepend the carried rows after deduplicating
          // against anything that already snuck back via a background
          // refetch.
          const idSet = new Set(input.insights.map((i) => i.id));
          const withoutDups = previousList.insights.filter((i) => !idSet.has(i.id));
          queryClient.setQueryData<BriefingData>(briefingKeys.insights(uid), {
            ...previousList,
            insights: [...input.insights, ...withoutDups],
          });
        }
      }

      return { previousList, removedInsights };
    },
    onError: (error, _variables, context) => {
      log.warn('bulk-dismiss mutation failed, rolling back cache', { error: error.message });
      if (context?.previousList) {
        queryClient.setQueryData(briefingKeys.insights(uid), context.previousList);
      }
    },
    onSettled: () => {
      // No per-id detail invalidation here — a bulk action typically
      // means the user isn't sitting on any single detail page right now.
      // The list refetch is enough to refresh server-truth.
      queryClient.invalidateQueries({ queryKey: briefingKeys.insights(uid) });
    },
  });
}
