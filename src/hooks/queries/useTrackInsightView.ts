/**
 * @file useTrackInsightView.ts
 * @description Fire-and-forget mutation that records a detail-page view
 * via the A.1 debounced view tracker (`POST /api/impulse/briefing/[id]/view`).
 *
 * Why a mutation hook and not a one-shot `fetchWithAuth`:
 *
 *   - The detail page calls this from `useEffect` on mount. A bare
 *     `fetchWithAuth` would fire on every re-render unless the component
 *     manages its own ref. A mutation hook gives us a stable callable.
 *   - The debounce lives server-side (the `:VIEWED_INSIGHT` sentinel edge
 *     per session). The client can hit this endpoint freely; the server
 *     short-circuits same-session repeats with `{ recorded: false }`.
 *   - No optimistic UI: a view doesn't change any visible state. We
 *     don't even need to invalidate the list — preference writes happen
 *     server-side and only matter for the next briefing fetch, which
 *     `useBriefing`'s normal staleTime handles.
 *
 * Errors are swallowed: a failed view-track shouldn't break the page.
 * Logged at `warn` so they're discoverable but not user-visible.
 */

import { useMutation } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useTrackInsightView');

interface TrackViewInput {
  insightId: string;
}

interface TrackViewResponse {
  recorded: boolean;
  topicsWritten: number;
}

async function trackViewRequest({ insightId }: TrackViewInput): Promise<TrackViewResponse> {
  const response = await fetchWithAuth(`/api/impulse/briefing/${encodeURIComponent(insightId)}/view`, {
    method: 'POST',
  });
  if (!response.ok) {
    // 429 / 500 / 404 are all caught by the route's error layer — the
    // component shouldn't care.
    if (response.status === 429) {
      throw new Error('Rate limit exceeded — view skipped');
    }
    throw new Error(`View track failed (${response.status})`);
  }
  return (await response.json()) as TrackViewResponse;
}

export function useTrackInsightView() {
  return useMutation<TrackViewResponse, Error, TrackViewInput>({
    mutationFn: trackViewRequest,
    onError: (error, variables) => {
      // Quiet — a view-track failure is not user-visible. Keep at warn so
      // a noisy log signal still helps when debugging the sentinel-edge
      // dedup behaviour.
      log.warn('view track failed (non-fatal)', {
        insightId: variables.insightId,
        error: error.message,
      });
    },
    // Single retry: the view tracker has a session dedup so a retried
    // call returns recorded:false harmlessly. Don't retry on 4xx though.
    retry: (failureCount, error) => {
      if (error.message.startsWith('Rate limit')) return false;
      if (error.message.includes('404')) return false;
      return failureCount < 1;
    },
  });
}
