/**
 * @file hooks/useRunEvents.ts
 * @description TanStack Query hook for one run's persisted step history —
 * the seed for the run detail page's Event Log card (live SSE events append
 * on top).
 *
 * Split out of `useAgentActivity.ts` (Task 22 follow-up fix): this hook's
 * `useAuth` import statically pulls in `firebase/auth`, which breaks
 * `src/hooks/__tests__/useAgentActivity.test.ts` (that suite mocks
 * `@/lib/firebase` but not `@/components/providers/AuthProvider`, so
 * importing `firebase/auth`'s real module graph throws `fetch is not
 * defined` at import time). Living in its own file keeps
 * `useAgentActivity.ts`'s import surface — and that pre-existing test —
 * untouched.
 *
 * @author Radarist Team
 * @created 2026-07-07
 */

import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import type { AgentEvent } from '@/lib/schemas/agent-event';

// ============================================================================
// TYPES
// ============================================================================

export interface RunEventsResult {
  events: AgentEvent[];
  /** True when the server-side query hit the 500-event cap on either the
   * mission or the sweep sub-query — see `getEventsForRun` in
   * `@/lib/agent-events`. The returned `events` are then an ARBITRARY
   * subset (Firestore's unspecified ordering on an unindexed equality
   * query), not reliably the first/last N — callers must render an honest
   * partial-history note, not silently show it as the full run. */
  truncated: boolean;
}

// ============================================================================
// QUERY KEY FACTORY
// ============================================================================

export const runEventsKeys = {
  all: ['activity', 'run-events'] as const,
  detail: (runId: string) => [...runEventsKeys.all, runId] as const,
};

// ============================================================================
// FETCH FUNCTION
// ============================================================================

/**
 * Fetch one run's persisted event history (mission or sweep id), ascending
 * by sequence, plus whether the server-side query was truncated.
 */
async function fetchRunEvents(runId: string): Promise<RunEventsResult> {
  const res = await fetchWithAuth(`/api/agents/runs/${encodeURIComponent(runId)}/events`);
  if (!res.ok) throw new Error(`Failed to fetch run events: ${res.status}`);
  const data = await res.json();
  return { events: data.events ?? [], truncated: Boolean(data.truncated) };
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * useRunEvents
 *
 * TanStack Query hook for one run's persisted step history. Auth-gated: the
 * query fires only once Firebase Auth has restored, so it never ships
 * without an Authorization header and 401s. `runId` is `undefined` when the
 * caller (the run detail page's `runEventScopeId`) can't resolve a scope at
 * all (e.g. a chat run or sweep-cycle summary that never emitted scoped
 * agent-events) — the query stays disabled in that case rather than firing
 * a fetch that can never return anything meaningful.
 *
 * @example
 * ```tsx
 * const { data, isLoading } = useRunEvents(runId)
 * const events = data?.events ?? []
 * ```
 */
export function useRunEvents(runId: string | undefined) {
  const { user, loading } = useAuth();
  const query = useQuery({
    queryKey: runEventsKeys.detail(runId ?? ''),
    queryFn: () => fetchRunEvents(runId ?? ''),
    enabled: !loading && !!user && !!runId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
  // Keep the skeleton up while Firebase auth is still restoring the session
  // — matching the sibling hooks in useAgentActivity.ts, which mirror
  // `query.isPending` (a disabled query has `isLoading === false` but
  // `isPending === true`). This hook can't blindly copy that: unlike the
  // siblings, its `enabled` also gates on `!!runId`, and `runId` can be
  // undefined PERMANENTLY (not just transiently, like auth restoration) —
  // a chat run or sweep-cycle summary never emits scoped agent-events at
  // all, so `runId` never resolves. Mirroring `isPending` there would pin
  // `isLoading` true forever, spinning the run detail page's Event Log
  // skeleton indefinitely instead of falling through to its "scope
  // unresolvable" note. Gating the override on `loading` alone fixes the
  // auth-restore flash without that regression.
  return { ...query, isLoading: loading ? true : query.isLoading };
}
