/**
 * @file useBriefingStatus.ts
 * @description UX-051 — TanStack Query hook for the briefing pipeline
 * status endpoint that powers the truthful empty states (no-exploration /
 * paused / pending / quiet / outage).
 *
 * Mounted only by `BriefingEmptyState`, which the feed renders exclusively
 * when the insight list is empty — so this fetch never runs while real
 * insights are on screen.
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { briefingKeys } from '@/hooks/useBriefing';

export interface BriefingLastSweep {
  at: string;
  status: 'ok' | 'quiet' | 'failed' | 'not-run' | 'unknown';
  insightsTotal: number | null;
  watchedInsights: number | null;
  narrativeInsights: number | null;
}

export interface BriefingStatusData {
  /** uid-scoped: does the caller have EXPLORED memory? null = source failed. */
  hasExploration: boolean | null;
  /** Resolved background-automation switch. null = source failed. */
  sweepEnabled: boolean | null;
  /** Why the effective switch is off; maintenance cannot be changed in UI. */
  pauseReason: 'settings' | 'maintenance' | null;
  /** Latest sweep-cycle summary with OBS-004 counters. null = none or failed. */
  lastSweep: BriefingLastSweep | null;
  /** True when any source failed — the UI must treat this as an outage. */
  degraded: boolean;
}

async function fetchBriefingStatus(): Promise<BriefingStatusData> {
  const response = await fetchWithAuth('/api/impulse/briefing/status');
  if (!response.ok) {
    throw new Error(`Briefing status fetch failed: ${response.status}`);
  }
  return response.json() as Promise<BriefingStatusData>;
}

export function useBriefingStatus() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: briefingKeys.status(user?.uid ?? 'anonymous'),
    queryFn: fetchBriefingStatus,
    enabled: !loading && !!user,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
