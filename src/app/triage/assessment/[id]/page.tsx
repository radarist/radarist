'use client';

/**
 * @file app/triage/assessment/[id]/page.tsx
 * @description Full-page detail for one inbox proposal (a net-new discovery or an
 * evaluation verdict) — opened by clicking a row in the Assessments table. Shows the
 * description, tags, verdict evidence (metrics, findings, verdict document + source run),
 * and a details sidebar (relevance, source), with Approve / Reject / Delete. Mirrors the
 * Signal detail page; reads from the shared useInbox hook.
 */
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Check, ExternalLink, FileText, FlaskConical, Sparkles, Trash2, X } from 'lucide-react';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell } from '@/components/layout/PageShell';
import { DetailPageShell } from '@/components/layout/DetailPageShell';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useInbox, useInboxArchive } from '@/hooks/useInbox';
import type { InboxRow } from '@/hooks/inbox-rows';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FindingsList } from '@/components/artifacts/FindingsList';
import { cn } from '@/lib/utils';
import { getEntityUrl } from '@/lib/entity-links';

function ProposalDetail() {
  const params = useParams();
  const router = useRouter();
  const id = decodeURIComponent(String(params.id ?? ''));
  const { rows, isLoading, anySourceFailed, retryFailed, retriesExhausted, busy, approve, reject, dismiss } =
    useInbox();
  const archive = useInboxArchive();
  // UX-053: degraded means SOME lane (or the archive) failed — the row may
  // exist but be temporarily invisible, which must not read as "resolved".
  const degraded = anySourceFailed || !!archive.error;
  // Pending rows are actionable; archived rows (approved/rejected/dismissed) are read-only.
  const row = rows.find((r) => r.id === id) ?? archive.rows.find((r) => r.id === id);
  const isPending = rows.some((r) => r.id === id);

  const back = () => router.push('/triage/assessment');
  const act = (fn: (r: InboxRow) => void) => {
    if (row) {
      fn(row);
      back();
    }
  };

  if (isLoading || (!row && archive.isLoading)) {
    return <Skeleton className="m-6 h-64 w-full max-w-4xl" />;
  }

  if (!row) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Button variant="ghost" className="px-0" onClick={back}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to Assessments
        </Button>
        {degraded ? (
          // AUDIT-008 / UX-053: a failed source is not "already resolved" — say
          // so honestly, name only the source CLASS (never raw error text), and
          // offer the bounded retry.
          <EmptyState
            icon={FlaskConical}
            title="Could not load this proposal"
            description="Some inbox sources are temporarily unavailable, so this proposal may exist but cannot be shown right now."
            action={
              retriesExhausted
                ? { label: 'Back to Assessments', onClick: back, variant: 'outline' }
                : {
                    label: 'Retry',
                    onClick: () => {
                      retryFailed();
                      if (archive.error) void archive.refetch();
                    },
                    variant: 'outline',
                  }
            }
          />
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            This proposal is no longer pending — it was approved, rejected, or deleted.
          </p>
        )}
      </div>
    );
  }

  return (
    <DetailPageShell
      backHref="/triage/assessment"
      backLabel="Back to Assessments"
      title={row.name}
      chips={
        <>
          <Badge
            variant={row.kind === 'discovery' ? 'default' : row.kind === 'recommendation' ? 'outline' : 'secondary'}
          >
            {row.kind === 'discovery' ? 'Discovery' : row.kind === 'recommendation' ? 'Recommendation' : 'Verdict'}
          </Badge>
          <Badge variant="outline" className="capitalize">
            {row.entityType}
          </Badge>
          {!isPending && (
            <Badge variant={row.status === 'approved' ? 'default' : 'outline'} className="capitalize">
              {row.status ?? 'resolved'}
            </Badge>
          )}
          {!isPending && row.generationStatus && row.generationStatus !== 'idle' && (
            <span className="text-sm text-muted-foreground">
              {row.generationStatus === 'generating' ? 'generating…' : row.generationStatus}
            </span>
          )}
        </>
      }
      actions={
        isPending ? (
          <>
            <Button onClick={() => act(approve)} disabled={busy}>
              <Check className="mr-1 h-4 w-4" /> Approve
            </Button>
            <Button variant="outline" onClick={() => act(reject)} disabled={busy}>
              <X className="mr-1 h-4 w-4" /> Reject
            </Button>
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => act(dismiss)}
              disabled={busy}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Delete
            </Button>
          </>
        ) : row.outputUrl ? (
          <Button asChild>
            <a href={row.outputUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1 h-4 w-4" /> View output
            </a>
          </Button>
        ) : undefined
      }
      aside={
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-muted-foreground">What approving does</p>
              <p>{row.effect}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Source</p>
              <p>{row.source}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Relevance</p>
              <p className="tabular-nums">{row.confidence}</p>
            </div>
            {row.sourceUrl && (
              <a
                href={row.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View source
              </a>
            )}
          </CardContent>
        </Card>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Description</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{row.detail || 'No description provided.'}</p>
        </CardContent>
      </Card>

      {row.kind === 'verdict' &&
        (row.evidenceMetrics?.length || row.evidenceFindings?.length || row.sourceDocumentId || row.sourceRunId) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="h-4 w-4 text-primary" /> Evidence
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {row.evidenceMetrics && row.evidenceMetrics.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Metric</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Command</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {row.evidenceMetrics.map((m, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell className="tabular-nums">{m.value}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{m.command ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {row.evidenceFindings && row.evidenceFindings.length > 0 && (
                <FindingsList findings={row.evidenceFindings} />
              )}
              {(row.sourceDocumentId || row.sourceRunId) && (
                <div className="flex flex-wrap gap-2">
                  {row.sourceDocumentId && (
                    <Button size="sm" variant="outline" asChild>
                      <Link href={getEntityUrl('document', row.sourceDocumentId) ?? '/library/documents'}>
                        <FileText className="mr-1 h-4 w-4" /> Open verdict document
                      </Link>
                    </Button>
                  )}
                  {row.sourceRunId && (
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/agents/runs?tab=builds&build=${row.sourceRunId}`}>
                        <ExternalLink className="mr-1 h-4 w-4" /> View source run
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

      {row.kind === 'recommendation' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-primary" /> What approving produces
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {row.artifactKind}
              </Badge>
              {row.updateTargetUrl && <Badge variant="secondary">Update in place</Badge>}
              {row.generationStatus && row.generationStatus !== 'idle' && (
                <span
                  className={cn(
                    'text-xs',
                    row.generationStatus === 'ready'
                      ? 'text-emerald-600'
                      : row.generationStatus === 'failed'
                        ? 'text-destructive'
                        : 'text-amber-600'
                  )}
                >
                  {row.generationStatus === 'generating' ? 'generating…' : row.generationStatus}
                </span>
              )}
            </div>
            {row.scopeQuery && (
              <p>
                <span className="text-muted-foreground">Scope: </span>
                {row.scopeQuery}
              </p>
            )}
            {row.updateTargetUrl && (
              <a
                href={row.updateTargetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View the current report (before the refresh)
              </a>
            )}
            {row.generationStatus === 'ready' && row.outputUrl && (
              <a
                href={row.outputUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" /> View the generated {row.artifactKind}
              </a>
            )}
          </CardContent>
        </Card>
      )}

      {(row.whyRelevant || row.matchedTopics.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" />{' '}
              {row.kind === 'recommendation' ? 'Why this is recommended' : 'Why the scout surfaced this'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {row.whyRelevant && <p className="text-sm text-muted-foreground">{row.whyRelevant}</p>}
            {row.matchedTopics.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Matches your interests in:</p>
                <div className="flex flex-wrap gap-1">
                  {row.matchedTopics.map((t) => (
                    <Badge key={t} variant="secondary" className="text-xs">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {row.tags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tags</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {row.tags.map((t) => (
                <Badge key={t} variant="outline" className="text-xs">
                  {t}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </DetailPageShell>
  );
}

export default function ProposalDetailPage() {
  return (
    <SmartLayout>
      <PageShell>
        <ErrorBoundary>
          <ProposalDetail />
        </ErrorBoundary>
      </PageShell>
    </SmartLayout>
  );
}
