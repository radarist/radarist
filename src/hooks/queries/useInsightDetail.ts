/**
 * @file useInsightDetail.ts
 * @description TanStack Query hook for the insight detail page
 * (A.1 — `GET /api/impulse/briefing/[id]`).
 *
 * Shape mirrors the list hook (`useBriefing`):
 *
 *   - Gated on Firebase auth via `useAuth()` so the query is `isPending`
 *     during the auth-restore window instead of firing with no token and
 *     landing in the error state (same regression pattern as Phase 0
 *     step 0.10 fixed for the list).
 *   - `retry: false` — a 404 (insight doesn't exist) and a 401 (token
 *     expired mid-page) are both terminal from the UI's perspective.
 *     Retrying would just hammer the server.
 *   - Returns the insight with A.0's structured-path fields
 *     (`relationshipTypes`, `pathLength`, `exploredAt`) so the "Why am I
 *     seeing this?" breadcrumb renders without a second round-trip.
 */

import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { briefingKeys, BriefingRequestError, classifyBriefingStatus, type BriefingInsight } from '@/hooks/useBriefing';
import { useAuth } from '@/components/providers/AuthProvider';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useInsightDetail');

/**
 * The detail-page payload. Identical shape to `BriefingInsight` —
 * the route strips server-only fields (`userId`, `consumed`) before
 * sending, so the consumer types are the same.
 */
export type InsightDetail = BriefingInsight;

async function fetchInsightDetail(insightId: string): Promise<InsightDetail | null> {
  let response: Response;
  try {
    response = await fetchWithAuth(`/api/impulse/briefing/${encodeURIComponent(insightId)}`);
  } catch (networkError) {
    // Unreachable server — surface as an unavailable outage (retryable), not a
    // stale link (UX-018).
    throw new BriefingRequestError(
      0,
      'unavailable',
      networkError instanceof Error ? networkError.message : 'Could not reach the insights service.'
    );
  }

  // A genuine miss (dismissed / stale deep link) → null so the UI shows the
  // "not found" copy. Kept distinct from a 503 outage below.
  if (response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BriefingRequestError(
      response.status,
      classifyBriefingStatus(response.status),
      `Insight detail fetch failed (${response.status}): ${text || response.statusText}`
    );
  }
  return (await response.json()) as InsightDetail;
}

export function useInsightDetail(insightId: string | undefined) {
  const { user, loading: authLoading } = useAuth();

  return useQuery<InsightDetail | null>({
    queryKey: briefingKeys.detail(user?.uid ?? 'anonymous', insightId ?? ''),
    queryFn: async () => {
      if (!insightId) return null;
      try {
        return await fetchInsightDetail(insightId);
      } catch (error) {
        log.warn('insight detail fetch failed', {
          insightId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    enabled: !!insightId && !authLoading && !!user,
    retry: false,
    // The detail page is a deep-link target — stale-while-revalidate
    // semantics are fine because we invalidate from like / dismiss
    // mutations, but cap the staleness at 60s for the "user reloads the
    // page after a peer dismissed it" race.
    staleTime: 60_000,
  });
}
