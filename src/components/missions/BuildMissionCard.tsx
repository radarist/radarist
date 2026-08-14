'use client';

/**
 * @file BuildMissionCard.tsx
 * @description RUN-STATUS card for a build mission (kind 'build') — the sole home
 * for run governance: phase stepper, budget meter, human gates (budget top-up /
 * stall / final), QA verdict, cancel. Rendered ONLY on Agent Runs › Builds.
 *
 * The OUTPUT (findings, preview, the produced entity, Iterate) lives in the
 * /artifacts outputs catalog — this card links there via "View output". Keeping
 * the two separate preserves the input-versus-output product boundary.
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, Hammer, ShieldCheck, Square, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { BuildRecoveryPanel } from '@/components/missions/BuildRecoveryPanel';
import { useCancelBuildMission, useResolveGate } from '@/hooks/queries/useBuildMissions';
import { MISSION_BUILD_PHASES, missionTitle, pendingGate } from '@/lib/build-mission-ui';
import { hasArtifactOutput } from '@/lib/artifact-output-ui';
import { missionUsageSnapshot } from '@/lib/mission-usage';
import { cn } from '@/lib/utils';
import type { Mission } from '@/lib/schemas/mission';

const STATE_BADGE: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  provisioning: { label: 'Provisioning', variant: 'secondary' },
  'session-running': { label: 'Building', variant: 'default' },
  'awaiting-budget': { label: 'Needs budget approval', variant: 'destructive' },
  'awaiting-stall': { label: 'Stalled — needs decision', variant: 'destructive' },
  qa: { label: 'QA review', variant: 'secondary' },
  'awaiting-approval': { label: 'Ready — awaiting approval', variant: 'destructive' },
  publishing: { label: 'Publishing', variant: 'secondary' },
  paused: { label: 'Paused', variant: 'outline' },
};

export function BuildMissionCard({ mission }: { mission: Mission }) {
  const [topUpUsd, setTopUpUsd] = useState('10');
  const resolveGate = useResolveGate();
  const cancelMission = useCancelBuildMission();

  const gate = pendingGate(mission);
  const usageSnapshot = missionUsageSnapshot(mission);
  const trackedSpend = usageSnapshot.costUsd;
  const cap = mission.budget?.capUsd ?? 0;
  const budgetPct =
    trackedSpend != null && cap > 0 ? Math.min(100, (trackedSpend / cap) * 100) : 0;
  const overWarn =
    trackedSpend != null &&
    cap > 0 &&
    trackedSpend / cap >= (mission.budget?.warnThreshold ?? 0.8);
  const phaseIdx = MISSION_BUILD_PHASES.indexOf(mission.buildPhase ?? '00-inception');
  const isActive = mission.status === 'running' || mission.status === 'pending';
  const badge =
    mission.status === 'completed'
      ? { label: mission.artifact ? 'Published' : 'Completed (not published)', variant: 'default' as const }
      : mission.status === 'failed'
        ? { label: 'Failed', variant: 'destructive' as const }
        : (STATE_BADGE[mission.buildState ?? ''] ?? { label: mission.status, variant: 'secondary' as const });

  const onResolve = (decision: 'approve' | 'deny') => {
    if (!gate) return;
    resolveGate.mutate({
      missionId: mission.id,
      gate,
      decision,
      ...(gate === 'budget' && decision === 'approve' ? { topUpUsd: Number(topUpUsd) || 10 } : {}),
    });
  };

  return (
    <Card data-testid="build-mission-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Hammer className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="line-clamp-1">{missionTitle(mission)}</span>
          </CardTitle>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        {/* Phase stepper */}
        <div className="mt-2 flex items-center gap-1" aria-label="build phases">
          {MISSION_BUILD_PHASES.map((phase, i) => (
            <div
              key={phase}
              title={phase}
              className={cn(
                'h-1.5 flex-1 rounded-full',
                i < phaseIdx && 'bg-primary',
                i === phaseIdx && (isActive ? 'animate-pulse bg-primary' : 'bg-primary'),
                i > phaseIdx && 'bg-muted'
              )}
            />
          ))}
        </div>
        <div className="text-xs text-muted-foreground">
          {/* sessions holds 2 entries per session (start + completion) — count
              distinct indices so this reads as the real session count. */}
          {mission.buildPhase ?? '00-inception'} · {new Set((mission.sessions ?? []).map((s) => s.index)).size} sessions
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Budget meter */}
        {cap > 0 && (
          <div data-testid="budget-meter">
            <div className="mb-1 flex justify-between text-xs">
              <span className={cn(overWarn && 'font-medium text-destructive')}>
                {trackedSpend != null
                  ? `$${trackedSpend.toFixed(2)}`
                  : usageSnapshot.costUnavailable
                    ? 'Unavailable'
                    : '—'}{' '}
                of ${cap.toFixed(2)}
              </span>
              {(mission.budget?.topUps?.length ?? 0) > 0 && (
                <span className="text-muted-foreground">{mission.budget!.topUps.length} top-up(s)</span>
              )}
            </div>
            <Progress value={budgetPct} className={cn('h-2', overWarn && '[&>div]:bg-destructive')} />
          </div>
        )}

        {/* Pending human gate */}
        {gate && (
          <div className="space-y-2 rounded-md border border-destructive/40 p-3" data-testid="gate-panel">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {gate === 'budget' && 'Budget exhausted — top up to continue?'}
              {gate === 'stall' && 'Repeated identical failures — keep going with a stronger model?'}
              {gate === 'final' && 'QA passed — publish this prototype?'}
            </div>
            <div className="flex items-center gap-2">
              {gate === 'budget' && (
                <Input
                  type="number"
                  min="1"
                  value={topUpUsd}
                  onChange={(e) => setTopUpUsd(e.target.value)}
                  className="h-8 w-24"
                  aria-label="Top-up amount (USD)"
                />
              )}
              <Button size="sm" onClick={() => onResolve('approve')} disabled={resolveGate.isPending}>
                Approve{gate === 'budget' ? ` +$${Number(topUpUsd) || 10}` : ''}
              </Button>
              <Button size="sm" variant="outline" onClick={() => onResolve('deny')} disabled={resolveGate.isPending}>
                Deny
              </Button>
            </div>
            {resolveGate.isError && <p className="text-xs text-destructive">{(resolveGate.error as Error).message}</p>}
          </div>
        )}

        <BuildRecoveryPanel mission={mission} />

        {/* QA verdict (run-level gate result) */}
        {mission.qaGate?.verdict && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-2 text-sm">
              <ShieldCheck
                className={cn('h-4 w-4', mission.qaGate.verdict === 'PASS' ? 'text-primary' : 'text-destructive')}
              />
              QA {mission.qaGate.verdict} · {mission.qaGate.findings.length} finding(s)
              <ChevronDown className="h-3 w-3" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {mission.qaGate.findings.map((finding, i) => (
                  <li key={i} className="flex gap-2">
                    <Badge
                      variant={finding.severity === 'minor' ? 'secondary' : 'destructive'}
                      className="h-4 text-[10px]"
                    >
                      {finding.severity}
                    </Badge>
                    <span>{finding.title}</span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Footer: error/result + View output (the artifact) + cancel */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {mission.errors?.length ? `Error: ${mission.errors[0]}` : (mission.result?.slice(0, 80) ?? '')}
          </span>
          <div className="flex items-center gap-2">
            {hasArtifactOutput(mission) && (
              <Button size="sm" variant="ghost" asChild data-testid="view-output">
                <Link href="/artifacts">
                  View output <ArrowRight className="ml-1 h-3 w-3" />
                </Link>
              </Button>
            )}
            {isActive && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => cancelMission.mutate(mission.id)}
                disabled={cancelMission.isPending}
                data-testid="cancel-button"
              >
                <Square className="mr-1 h-3 w-3" /> {cancelMission.isPending ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
          </div>
        </div>
        {/* BUILD-026 — a cancel that the server refused (e.g. the sandbox
            wouldn't stop) must say so; the button stays enabled to retry. */}
        {cancelMission.isError && (
          <p className="mt-2 text-right text-xs text-destructive" data-testid="cancel-error">
            {cancelMission.error instanceof Error ? cancelMission.error.message : 'Could not cancel the run.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
