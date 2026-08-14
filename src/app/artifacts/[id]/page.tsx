'use client';

/**
 * @file app/artifacts/[id]/page.tsx
 * @description Full detail page for a build-mission artifact (mirrors the
 * reports detail page). Per-kind body: an App shows its live preview + Start/
 * Open + a link to the Prototype; an Evaluation shows the verdict header +
 * findings + links to the verdict Document / Technology / pending Assessment;
 * a Document/Report links to the document. A failed source run shows a banner.
 */
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FileText,
  FlaskConical,
  Hammer,
  Play,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { EmptyState } from '@/components/feedback/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DataTableSkeleton } from '@/components/skeletons';
import { FindingsList } from '@/components/artifacts/FindingsList';
import { BuildRecoveryPanel } from '@/components/missions/BuildRecoveryPanel';
import {
  useBuildMissions,
  useIterateBuildMission,
  useStartBuildArtifact,
} from '@/hooks/queries/useBuildMissions';
import {
  ARTIFACT_KIND_BADGE,
  artifactKindOf,
  outputStatus,
  OUTPUT_STATUS_TINT,
  outputRef,
  previewState,
  verdictFinding,
} from '@/lib/artifact-output-ui';
import { missionTitle } from '@/lib/build-mission-ui';
import { getEntityUrl } from '@/lib/entity-links';
import { cn } from '@/lib/utils';
import type { Mission } from '@/lib/schemas/mission';

const KIND_ICON = { solution: Hammer, evaluation: FlaskConical, architecture: Workflow, report: FileText };

function ArtifactDetail({ mission }: { mission: Mission }) {
  const kind = artifactKindOf(mission);
  const badge = ARTIFACT_KIND_BADGE[kind];
  const Icon = KIND_ICON[kind];
  const status = outputStatus(mission);
  const ref = outputRef(mission);
  const start = useStartBuildArtifact();
  const iterate = useIterateBuildMission();
  const [instructions, setInstructions] = useState('');
  // BUILD-019 — only offer Iterate when it can actually succeed: the mission must
  // be finished (a running one must be cancelled first) and its sandbox must
  // still have a retained workspace (AUDIT-017). The server enforces both anyway;
  // this just avoids offering a button that can only fail.
  const canIterate =
    mission.status !== 'running' && mission.status !== 'pending' && mission.sandbox?.state !== 'destroyed';
  const preview = previewState(mission);
  const verdict = verdictFinding(mission);
  const findings = (mission.findings ?? []).map((f) => ({
    title: f.title,
    detail: f.detail,
    kind: f.kind,
    metric: f.metric,
    confidence: f.confidence,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              {missionTitle(mission)}
              <Badge
                variant="outline"
                className={cn('gap-1 px-2 py-0.5 text-xs font-normal', badge.className, badge.tint)}
              >
                {badge.label}
              </Badge>
            </h1>
            <Badge
              variant="outline"
              className={cn('gap-1 px-2 py-0.5 text-xs font-normal', OUTPUT_STATUS_TINT[status.status])}
            >
              {status.label}
            </Badge>
          </div>
        </div>
      </div>

      {mission.status === 'failed' && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p>The source run failed — this output may be partial.</p>
            {mission.errors?.length ? (
              <p className="break-words font-mono text-xs text-destructive">{mission.errors[0]}</p>
            ) : (
              <p className="text-muted-foreground">See the run for diagnostics.</p>
            )}
          </div>
        </div>
      )}

      <BuildRecoveryPanel mission={mission} />

      {/* App: live preview + controls + Prototype link */}
      {kind === 'solution' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {preview === 'stopped' && (
              <Button
                size="sm"
                variant="outline"
                disabled={start.isPending}
                onClick={() => start.mutate(mission.id)}
              >
                <Play className="mr-1 h-4 w-4" /> {start.isPending ? 'Starting…' : 'Start'}
              </Button>
            )}
            {ref.previewUrl && (
              <Button size="sm" variant="ghost" asChild>
                <a href={ref.previewUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1 h-4 w-4" /> Open in new tab
                </a>
              </Button>
            )}
            {ref.href && (
              <Button size="sm" variant="ghost" asChild>
                <Link href={ref.href}>Open prototype entity</Link>
              </Button>
            )}
          </div>
          {/* BUILD-026 — Start now verifies the volume, container, and preview
              before reporting success. Retryable refusals keep the action;
              a proven missing volume is persisted as destroyed and removes it. */}
          {start.isError && (
            <p className="text-sm text-destructive" data-testid="artifact-start-error">
              {start.error instanceof Error ? start.error.message : 'Could not start the preview. Please retry.'}
            </p>
          )}
          {/* Honest preview state — the container is idled/reclaimed by the GC, so
              say so instead of leaving a Start button that silently fails. */}
          {preview === 'stopped' && (
            <p className="text-sm text-muted-foreground">
              The live preview was stopped to free resources. Click <span className="font-medium">Start</span> to bring
              it back — the workspace is intact.
            </p>
          )}
          {preview === 'expired' && (
            <p className="text-sm text-muted-foreground">
              The retained preview workspace is no longer available, so the live demo is gone. The published prototype
              and its findings remain; start a new mission to rebuild a preview.
            </p>
          )}
          {ref.previewUrl && (
            <iframe
              src={ref.previewUrl}
              title={`Preview of ${missionTitle(mission)}`}
              className="h-[480px] w-full rounded-md border bg-background"
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          )}
        </div>
      )}

      {/* Evaluation: verdict header + findings + links */}
      {kind === 'evaluation' && (
        <div className="space-y-4">
          {verdict && (
            <div className="rounded-md border p-4">
              <div className="text-sm font-semibold">{verdict.title}</div>
              {verdict.detail && <p className="mt-1 text-sm text-muted-foreground">{verdict.detail}</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {ref.href && (
              <Button size="sm" variant="outline" asChild>
                <Link href={ref.href}>Open verdict document</Link>
              </Button>
            )}
            {mission.motivation?.sourceTechnologyId && (
              <Button size="sm" variant="ghost" asChild>
                <Link
                  href={getEntityUrl('technology', mission.motivation.sourceTechnologyId) ?? '/library/technologies'}
                >
                  Evaluated technology
                </Link>
              </Button>
            )}
            {mission.artifact?.assessmentId && (
              <Button size="sm" asChild>
                <Link href="/triage/assessment">Review verdict in triage</Link>
              </Button>
            )}
          </div>
          {findings.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold">Findings</h2>
              <FindingsList findings={findings} />
            </div>
          )}
        </div>
      )}

      {/* Architecture / report: the document */}
      {(kind === 'architecture' || kind === 'report') && (
        <div className="space-y-4">
          {ref.href && (
            <Button size="sm" variant="outline" asChild>
              <Link href={ref.href}>Open document</Link>
            </Button>
          )}
          {findings.length > 0 && <FindingsList findings={findings} />}
        </div>
      )}

      {/*
       * BUILD-019 — Iterate, on the artifact itself.
       *
       * The iterate CORE has always worked (the API route + the
       * `iterateBuildArtifact` chat tool both call it), but `useIterateBuildMission`
       * had zero consumers: the row's acceptance named an artifact-UI action and
       * only the assistant-native half ever shipped. This is that action.
       *
       * The error surface matters as much as the button: the server's refusals are
       * relayed verbatim, so a reclaimed sandbox (AUDIT-017) and an exhausted
       * budget (AUDIT-016) say exactly that instead of failing opaquely.
       */}
      {canIterate && (
        <div className="space-y-2 rounded-md border p-3">
          <h2 className="text-sm font-semibold">Iterate</h2>
          <p className="text-xs text-muted-foreground">
            Resume this build in its existing sandbox and apply follow-up instructions. The iteration must earn its own
            QA pass.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. add a dark mode toggle to the settings page"
              className="min-w-[16rem] flex-1"
              disabled={iterate.isPending}
            />
            <Button
              size="sm"
              disabled={iterate.isPending || instructions.trim().length === 0}
              onClick={() => iterate.mutate({ missionId: mission.id, instructions: instructions.trim() })}
            >
              <RefreshCw className="mr-1 h-4 w-4" /> {iterate.isPending ? 'Dispatching…' : 'Iterate'}
            </Button>
          </div>
          {iterate.isError && (
            <p className="text-xs text-destructive" data-testid="artifact-iterate-error">
              {iterate.error instanceof Error ? iterate.error.message : 'Iterate failed'}
            </p>
          )}
          {iterate.isSuccess && (
            <p className="text-xs text-muted-foreground" data-testid="artifact-iterate-ok">
              Iteration dispatched — follow it on the source run.
            </p>
          )}
        </div>
      )}

      <Link
        href={`/agents/runs?tab=builds&build=${mission.id}`}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
      >
        <ExternalLink className="h-3 w-3" /> View the source run
      </Link>
    </div>
  );
}

export default function ArtifactDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const { data: missions, isLoading, error, refetch } = useBuildMissions();
  const mission = missions?.find((m) => m.id === id);

  return (
    <SmartLayout>
      <PageShell>
        <PageContent>
          <ErrorBoundary>
            <Button variant="ghost" size="sm" className="mb-4" onClick={() => router.push('/artifacts')}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back to Artifacts
            </Button>
            {isLoading ? (
              <DataTableSkeleton rows={4} columns={2} />
            ) : error ? (
              // AUDIT-008: a failed fetch must NOT render "Artifact not found."
              <EmptyState
                icon={Hammer}
                title="Could not load artifact"
                description={error instanceof Error ? error.message : 'Unknown error'}
                action={{ label: 'Retry', onClick: () => void refetch() }}
              />
            ) : !mission ? (
              <p className="text-sm text-muted-foreground">Artifact not found.</p>
            ) : (
              <ArtifactDetail mission={mission} />
            )}
          </ErrorBoundary>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
