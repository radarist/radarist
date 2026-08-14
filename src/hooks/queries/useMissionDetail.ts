/**
 * @file useMissionDetail.ts
 * @description ARUN-029 — one Mission doc by id, for the run detail page.
 *
 * `/agents/runs/[id]` already loads build missions (`useBuildMissions`) and
 * in-flight research missions (`useRunningMissions`), but a COMPLETED Creator
 * run appears in neither list: it resolves from its `AgentRun` history entry
 * alone. Everything the mission recorded about how it ended — the structured
 * `failureCode`, the `outcome`, the canonical `reportId`, the `partial` flag,
 * its own stored usage — therefore never reached the page. This fetches that
 * one doc through the existing owner-scoped `GET /api/missions/[id]`.
 *
 * A 404 resolves to `null` (the run genuinely has no mission doc — a chat run,
 * or a mission whose doc was deleted); every other failure throws so the caller
 * can distinguish "no mission" from "we could not read the mission" and refuse
 * to present the run's own numbers as reconciled.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { missionDetailKeys } from '@/lib/query-keys';
import type { Mission } from '@/lib/schemas/mission';

async function fetchMission(missionId: string): Promise<Mission | null> {
  const response = await fetchWithAuth(`/api/missions/${encodeURIComponent(missionId)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `Mission lookup failed (${response.status})`);
  }
  return (await response.json()) as Mission;
}

/**
 * The Mission doc behind a run, or `null` when the run has none. Disabled
 * (and `data: undefined`) while no mission id is known — the caller must treat
 * that as "not looked up", never as "no mission".
 */
export function useMissionDetail(missionId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: missionDetailKeys.detail(user?.uid ?? 'anonymous', missionId ?? 'none'),
    enabled: Boolean(user?.uid) && Boolean(missionId),
    queryFn: () => fetchMission(missionId!),
    staleTime: 30 * 1000,
  });
}
