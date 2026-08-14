/**
 * @file useRunningMissions.ts
 * @description TanStack Query hook for in-flight research/report missions —
 * the durable "running" source for `/agents/runs` (ARUN-001). Mirrors
 * `useBuildMissions`: polls faster while a run is live so a dispatched mission
 * appears within one poll and persists (and survives reload) until it lands in
 * the completed AgentRun history, instead of only flickering through the
 * ephemeral SSE stream. Build missions have their own hook and are excluded by
 * the underlying `getRunningMissions` read.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { getRunningMissions } from '@/lib/missions-client';
import { runningMissionKeys } from '@/lib/query-keys';
import type { Mission } from '@/lib/schemas/mission';

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

/** In-flight (running/pending) research/report missions for the signed-in
 * user; polls faster while at least one is live. */
export function useRunningMissions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: runningMissionKeys.list(user?.uid ?? 'anonymous'),
    enabled: Boolean(user?.uid),
    queryFn: () => getRunningMissions(user!.uid),
    refetchInterval: (query) => {
      const missions = query.state.data as Mission[] | undefined;
      return missions && missions.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    },
  });
}
