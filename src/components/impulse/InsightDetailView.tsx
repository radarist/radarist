/**
 * @file InsightDetailView.tsx
 * @description Client component for `/triage/insights/[id]`. Owns:
 *
 *   - Detail fetch via `useInsightDetail`.
 *   - View-tracker fire-and-forget call on mount (Q1 contract).
 *   - Engagement actions (like toggle, dismiss + undo) reusing the
 *     same hooks the table row uses, so behaviour is identical from
 *     both surfaces.
 *
 * The page server-shell (`page.tsx`) just renders this with `params.id`
 * — keeping the data + engagement logic in one client component avoids
 * threading state through a Suspense boundary.
 *
 * "Why am I seeing this?" is delegated to `<WhyAmISeeingThis>` (separate
 * file) so it stays testable in isolation against pre/post-A.0 inputs.
 */

'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ThumbsUp, ThumbsDown, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

import { formatEnumLabel } from '@/lib/enum-label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DetailPageShell } from '@/components/layout/DetailPageShell';

import { InsightTypeBadge } from './InsightTypeBadge';
import { ConfidenceIndicator } from './ConfidenceIndicator';
import { WhyAmISeeingThis } from './WhyAmISeeingThis';
import { LinkedEntitiesCard } from './LinkedEntitiesCard';
import { RelatedInsightsCard } from './RelatedInsightsCard';
import { useInsightDetail } from '@/hooks/queries/useInsightDetail';
import { BriefingRequestError } from '@/hooks/useBriefing';
import { useLikeInsight } from '@/hooks/queries/useLikeInsight';
import { useDismissInsight } from '@/hooks/queries/useDismissInsight';
import { useUndismissInsight } from '@/hooks/queries/useUndismissInsight';
import { useTrackInsightView } from '@/hooks/queries/useTrackInsightView';
import { useBriefing } from '@/hooks/useBriefing';
import { displayInsightTitle } from '@/lib/graph/insight-actions';
import { cn } from '@/lib/utils';

const UNDO_DURATION_MS = 5_000;

interface InsightDetailViewProps {
  insightId: string;
}

export function InsightDetailView({ insightId }: InsightDetailViewProps) {
  const router = useRouter();
  const { data: insight, isPending, isError, error, refetch } = useInsightDetail(insightId);
  const { data: briefingData } = useBriefing();
  const like = useLikeInsight();
  const dismiss = useDismissInsight();
  const undismiss = useUndismissInsight();
  const trackView = useTrackInsightView();

  // Fire the view tracker exactly once per (mount, insightId). The
  // sentinel-edge dedup is server-side (Q1), so a repeat call from the
  // same session returns `recorded: false` without writing — but the
  // ref still avoids burning rate-limit tokens on re-renders.
  const viewedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!insight) return;
    if (viewedRef.current === insightId) return;
    viewedRef.current = insightId;
    trackView.mutate({ insightId });
    // We deliberately do NOT include `trackView` in the deps — its
    // identity changes on every render and would loop the effect.
  }, [insightId, insight]);

  if (isPending) return <DetailSkeleton />;

  // UX-018: an outage is retryable and must NOT read as a stale link. Only a
  // genuine miss (insight === null, from a 404) is the "not found" case.
  if (isError) {
    return <InsightDetailUnavailable error={error} onRetry={() => refetch()} />;
  }

  if (!insight) {
    return (
      <div className="flex flex-col items-start gap-4 p-6" data-testid="detail-empty">
        <BackToInsightsLink />
        <h1 className="text-2xl font-semibold tracking-tight">Insight not found</h1>
        <p className="text-sm text-muted-foreground">
          This insight may have been dismissed by another user, or the link is stale.
        </p>
      </div>
    );
  }

  const entityNamesById = new Map<string, string>(insight.relatedEntities.map((e) => [e.id, e.name]));
  const createdAtDate = new Date(insight.createdAt);
  const createdAtRelative = formatDistanceToNow(createdAtDate, { addSuffix: true });
  const createdAtAbsolute = createdAtDate.toLocaleString();

  const handleLikeToggle = () => {
    like.mutate({ insightId: insight.id, liked: !insight.liked });
  };

  const handleDismiss = () => {
    // Capture the snapshot for undo BEFORE firing the mutation — once
    // the cache patch lands, the row is gone.
    const snapshot = { ...insight };
    dismiss.mutate(
      { insightId: insight.id },
      {
        onSuccess: () => {
          toast.success('Insight dismissed', {
            duration: UNDO_DURATION_MS,
            action: {
              label: 'Undo',
              onClick: () => undismiss.mutate({ insight: snapshot }),
            },
          });
          // Navigate back to the briefing list after dismiss — the row
          // is gone from the cache, lingering on the detail page looks
          // like a dead end.
          router.push('/triage/insights');
        },
        onError: (err) => {
          toast.error('Failed to dismiss insight', { description: err.message });
        },
      }
    );
  };

  return (
    <div data-testid="detail-view">
      <DetailPageShell
        backHref="/triage/insights"
        backLabel="Back to Insights"
        title={displayInsightTitle(insight.title)}
        chips={
          <>
            <InsightTypeBadge type={insight.type} />
            <span className="text-sm text-muted-foreground">by {formatEnumLabel(insight.agentName)}</span>
            <span className="text-muted-foreground/50">·</span>
            <ConfidenceIndicator score={insight.confidenceScore} />
          </>
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleLikeToggle}
              data-testid="detail-like"
              aria-label={insight.liked ? 'Remove like' : 'Like insight'}
              // Emerald treatment in the active state matches the row's
              // like button — both surfaces use the same colour for the
              // same semantic.
              className={cn(
                insight.liked &&
                  'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-100 hover:text-emerald-600'
              )}
            >
              <ThumbsUp className={cn('h-4 w-4 mr-2', insight.liked && 'fill-current')} />
              {insight.liked ? 'Liked' : 'Like'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDismiss}
              data-testid="detail-dismiss"
              // Destructive hover treatment — matches the signals reject
              // button + the row's dismiss button so the colour grammar
              // stays consistent.
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <ThumbsDown className="h-4 w-4 mr-2" />
              Dismiss
            </Button>
          </>
        }
        aside={
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Details</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <DetailRow
                  label="Detected"
                  value={
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{createdAtRelative}</span>
                        </TooltipTrigger>
                        <TooltipContent>{createdAtAbsolute}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  }
                />
                <DetailRow
                  label="Agent"
                  value={<span className="font-medium">{formatEnumLabel(insight.agentName)}</span>}
                />
                <DetailRow label="Confidence" value={<ConfidenceIndicator score={insight.confidenceScore} />} />
              </CardContent>
            </Card>

            <LinkedEntitiesCard entities={insight.relatedEntities} />
          </>
        }
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-foreground/90 leading-relaxed">{insight.summary}</p>
            {/* UX-048: the summary rendered above is passed in so the
                provenance block never prints the same sentence twice. */}
            <WhyAmISeeingThis insight={insight} entityNamesById={entityNamesById} visibleSummary={insight.summary} />
          </CardContent>
        </Card>

        <RelatedInsightsCard current={insight} allInsights={briefingData?.insights ?? []} />
      </DetailPageShell>
    </div>
  );
}

function BackToInsightsLink() {
  return (
    <Link
      href="/triage/insights"
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      data-testid="detail-back"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to Insights
    </Link>
  );
}

/**
 * UX-018 — retryable "unavailable" state for the detail page, kept visually
 * distinct from the "Insight not found" stale-link copy so an outage doesn't
 * masquerade as a deleted insight.
 */
function InsightDetailUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const kind = error instanceof BriefingRequestError ? error.kind : 'error';
  const title =
    kind === 'rate-limited'
      ? 'Too many requests'
      : kind === 'unauthorized'
        ? 'Your session expired'
        : 'This insight is temporarily unavailable';
  const description =
    kind === 'rate-limited'
      ? "You've hit the rate limit. Wait a moment, then retry."
      : kind === 'unauthorized'
        ? 'Sign back in to view this insight, then retry.'
        : "We couldn't reach the insights service. This is a connection issue, not a deleted insight — try again in a moment.";

  return (
    <div className="flex flex-col items-start gap-4 p-6" data-testid="detail-unavailable">
      <BackToInsightsLink />
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} data-testid="detail-retry">
        <RefreshCw className="h-4 w-4 mr-2" />
        Retry
      </Button>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6" data-testid="detail-skeleton">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-10 w-2/3" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-48 md:col-span-2" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}
