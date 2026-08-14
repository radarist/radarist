'use client';

/**
 * @file BriefingEmptyState.tsx
 * @description UX-051 — the empty briefing feed distinguishes five real
 * pipeline states instead of the old static "your agents are working in
 * the background" claim (which was untrue whenever sweeps were paused,
 * failing, or had simply never processed the user's activity):
 *
 *   outage    — status unavailable / degraded / last sweep failed
 *   paused    — background sweeps are disabled
 *   noexplore — the user has no exploration memory yet
 *   pending   — exploration exists but no sweep has processed it
 *   quiet     — pipeline healthy; genuinely nothing unread
 *   not-run   — the sweep ended before REFLECT because there was no
 *               actionable work; zero insight counters do not imply a pass
 *
 * Each state names the exact action that can advance it, and none of the
 * copy promises guaranteed output.
 */

import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Compass, Lightbulb, PauseCircle, Timer } from 'lucide-react';

import { EmptyState } from '@/components/feedback/EmptyState';
import { CardGridSkeleton } from '@/components/skeletons';
import { useBriefingStatus, type BriefingLastSweep } from '@/hooks/queries/useBriefingStatus';

/** "completed 2 hours ago" — omitted entirely when the timestamp is unusable. */
function sweepRecency(lastSweep: BriefingLastSweep): string {
  const parsed = Date.parse(lastSweep.at);
  if (!Number.isFinite(parsed)) return '';
  return ` (completed ${formatDistanceToNow(parsed, { addSuffix: true })})`;
}

/** Honest quiet-state copy per what the last sweep actually reported. */
function quietDescription(lastSweep: BriefingLastSweep): string {
  const recency = sweepRecency(lastSweep);
  if (lastSweep.status === 'ok') {
    return `The last sweep${recency} surfaced ${lastSweep.insightsTotal ?? 0} insights, but nothing is unread for you right now. New insights appear when entities you've explored change — output isn't guaranteed.`;
  }
  if (lastSweep.status === 'unknown') {
    return `The last sweep${recency} completed, but per-cycle counts weren't recorded for that run. Nothing is unread for you right now — output isn't guaranteed.`;
  }
  if (lastSweep.status === 'not-run') {
    return `The last sweep${recency} completed before insight generation because it found no actionable work. Nothing is unread for you right now — output isn't guaranteed.`;
  }
  return `The last sweep${recency} ran healthily and found no new insights. New insights appear when entities you've explored change — output isn't guaranteed.`;
}

export function BriefingEmptyState() {
  const { data, isPending, isError } = useBriefingStatus();
  const router = useRouter();

  if (isPending) {
    return (
      <div data-testid="briefing-empty-loading" className="p-4">
        <CardGridSkeleton columns={1} cards={1} />
      </div>
    );
  }

  // Outage: the status itself failed, a source degraded, or the last sweep
  // errored. Unknown health must never be presented as a clean inbox.
  if (isError || !data || data.degraded || data.lastSweep?.status === 'failed') {
    return (
      <div data-testid="briefing-empty-outage">
        <EmptyState
          icon={AlertTriangle}
          title="Insight status unavailable"
          description="Background processing hit a problem — insight generation may be delayed or failing. Check the agent runs page for details."
          action={{ label: 'View agent runs', onClick: () => router.push('/agents/runs') }}
        />
      </div>
    );
  }

  if (data.sweepEnabled === false) {
    const maintenancePaused = data.pauseReason === 'maintenance';
    return (
      <div data-testid="briefing-empty-paused">
        <EmptyState
          icon={PauseCircle}
          title="Background sweeps are paused"
          description={
            maintenancePaused
              ? 'The process-wide maintenance guard is active, so automated insight generation will stay paused until MAINTENANCE_PAUSED is disabled and the app is restarted.'
              : "Automated insight generation is switched off, so nothing new will appear here until it's re-enabled."
          }
          action={
            maintenancePaused
              ? { label: 'View agent runs', onClick: () => router.push('/agents/runs') }
              : { label: 'Open agent settings', onClick: () => router.push('/settings?tab=agent-config') }
          }
        />
      </div>
    );
  }

  if (data.hasExploration === false) {
    return (
      <div data-testid="briefing-empty-noexplore">
        <EmptyState
          icon={Compass}
          title="No insights yet"
          description="Insights are matched against entities you've explored, and the radar hasn't seen you view any yet. Open a technology or company to give it a starting point."
          action={{ label: 'Browse technologies', onClick: () => router.push('/library/technologies') }}
        />
      </div>
    );
  }

  if (data.lastSweep === null) {
    return (
      <div data-testid="briefing-empty-pending">
        <EmptyState
          icon={Timer}
          title="Waiting on a sweep result"
          description="You've explored entities, but no recent background sweep result is visible yet. The next scheduled sweep will check for updates relevant to you — it may find nothing."
          action={{ label: 'View agent runs', onClick: () => router.push('/agents/runs') }}
        />
      </div>
    );
  }

  return (
    <div data-testid="briefing-empty-quiet">
      <EmptyState
        icon={Lightbulb}
        title="Nothing new right now"
        description={quietDescription(data.lastSweep)}
        action={{ label: 'Keep exploring', onClick: () => router.push('/library/technologies') }}
      />
    </div>
  );
}
