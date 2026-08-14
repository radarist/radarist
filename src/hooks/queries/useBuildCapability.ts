/**
 * @file useBuildCapability.ts
 * @description TanStack Query hook exposing whether build missions are enabled
 * on this instance (BUILD-027), so the dispatch UI can show the truth before a
 * user writes a brief instead of surfacing it only as a 403 on submit.
 *
 * Reads `GET /api/missions/capabilities`, which resolves the same
 * `IMPULSE_BUILD_ENABLED` flag the dispatch route enforces. Auth-gated (like
 * `useBriefing`) so it never fires before Firebase restores the session.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

export interface MissionCapabilities {
  buildEnabled: boolean;
}

async function fetchBuildCapability(): Promise<MissionCapabilities> {
  const res = await fetchWithAuth('/api/missions/capabilities');
  if (!res.ok) throw new Error(`Capability probe failed (${res.status})`);
  return (await res.json()) as MissionCapabilities;
}

export const buildCapabilityKeys = {
  all: ['mission-capabilities'] as const,
};

/**
 * `data.buildEnabled` is the source of truth for the dispatch button.
 *
 * While the probe is loading or has errored, `data` is undefined — callers
 * should treat "unknown" conservatively (don't claim builds are available),
 * but must not block on it forever: the server still enforces the gate, so a
 * failed probe degrades to the pre-BUILD-027 behaviour (dispatch attempts and
 * the API refuses) rather than a dead button.
 */
export function useBuildCapability() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: buildCapabilityKeys.all,
    queryFn: fetchBuildCapability,
    enabled: !loading && !!user,
    staleTime: 5 * 60 * 1000, // the flag changes only on a server restart
    refetchOnWindowFocus: false,
  });
}
