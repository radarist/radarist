'use client';

/**
 * @file components/scouting/CompanyReviewPanel.tsx
 * @description AI-043 — the inline human source-review panel for a company
 * research draft. Shows each reviewable claim/section with its value, safe source
 * references, current decision + who/when, a stale indicator, the hard blockers
 * (contradictions, missing evidence, incomplete sourcing), and the derived
 * readiness with reasons. Records approve / reject / needs-changes decisions and
 * exposes a SEPARATE explicit "promote approved fields" action.
 *
 * Trust rules honored here: no optimistic "reviewed" state (the durable server
 * state is re-read on success); an error preserves the reviewer's note; a stale
 * draft blocks action until reloaded; a generic Company save never appears here.
 */

import * as React from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, XCircle, Pencil } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { canonicalHttpUrl } from '@/lib/signals/source-identity';
import {
  currentDecisionForArea,
  isStaleEvent,
  type CompanyReviewArea,
  type CompanyReviewDecision,
} from '@/lib/company-review';
import {
  useCompanyReview,
  useRecordReviewDecision,
  usePromoteReviewClaims,
  StaleDraftError,
} from '@/hooks/queries/useCompanyReview';

const DECISION_LABEL: Record<CompanyReviewDecision, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  needs_changes: 'Needs changes',
};

const DECISION_CLASS: Record<CompanyReviewDecision, string> = {
  approved: 'bg-green-500/10 text-green-600 border-green-500/20',
  rejected: 'bg-red-500/10 text-red-600 border-red-500/20',
  needs_changes: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
};

function formatWhen(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

/** Truthful post-promotion graph-sync suffix — distinct per handoff outcome. */
function graphSyncNote(status: 'delivered' | 'deferred' | 'suppressed' | 'failed'): string {
  switch (status) {
    case 'deferred':
      return ' · committed, graph sync reconciling';
    case 'failed':
      return ' · committed, but graph sync failed — not yet reconciled';
    case 'suppressed':
    case 'delivered':
      return '';
  }
}

export function CompanyReviewPanel({ companyId }: { companyId: string }) {
  const { data, isLoading, error, refetch } = useCompanyReview(companyId);
  const record = useRecordReviewDecision(companyId);
  const promote = usePromoteReviewClaims(companyId);

  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState<string | null>(null);
  const [areaErrors, setAreaErrors] = React.useState<Record<string, string>>({});
  const [staleBlocked, setStaleBlocked] = React.useState(false);

  if (isLoading) {
    return <div className="text-xs text-muted-foreground">Loading source review…</div>;
  }
  if (error) {
    return (
      <Card className="border-red-500/30 bg-red-500/5">
        <CardContent className="flex items-center justify-between gap-2 py-3 text-xs">
          <span className="text-red-600">Could not load source review: {error.message}</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!data || !data.projection.hasDraft || data.projection.artifactKind === null) return null;

  const { projection, readiness, events } = data;

  const submit = (area: CompanyReviewArea, decision: CompanyReviewDecision) => {
    if (staleBlocked) return;
    const key = `${area.key}:${decision}`;
    setPending(key);
    setAreaErrors((prev) => ({ ...prev, [area.key]: '' }));
    record.mutate(
      {
        artifactKind: projection.artifactKind!,
        artifactVersion: projection.artifactVersion,
        area: area.key,
        areaDigest: area.areaDigest,
        draftDigest: projection.draftDigest,
        sourceIds: area.sourceIds,
        decision,
        note: notes[area.key]?.trim() || undefined,
      },
      {
        onSuccess: () => {
          // No optimistic state — the query is invalidated and re-read. Clear the
          // note only after the server acknowledges.
          setNotes((prev) => ({ ...prev, [area.key]: '' }));
          setPending(null);
        },
        onError: (e) => {
          // Preserve the reviewer's note on failure.
          if (e instanceof StaleDraftError) setStaleBlocked(true);
          setAreaErrors((prev) => ({ ...prev, [area.key]: e instanceof Error ? e.message : 'Failed to record' }));
          setPending(null);
        },
      }
    );
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="py-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Source review
          <Badge variant="outline" className="text-[10px] font-normal">
            {projection.artifactKind} · v{projection.artifactVersion}
          </Badge>
          <span
            className={cn(
              'ml-auto rounded-full px-2 py-0.5 text-xs font-medium',
              readiness.ready ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
            )}
          >
            {readiness.ready ? 'Review complete' : 'Review incomplete'}
          </span>
        </CardTitle>
        {projection.lastResearchedAt !== undefined && (
          <p className="text-[11px] text-muted-foreground">Draft generated {formatWhen(projection.lastResearchedAt)}</p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Stale reload prompt */}
        {staleBlocked && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <span>The draft changed since it loaded. Reload to review the current version.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setStaleBlocked(false);
                void refetch();
              }}
            >
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
              Reload
            </Button>
          </div>
        )}

        {/* Readiness reasons */}
        {!readiness.ready && readiness.reasons.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-muted-foreground" aria-label="Why review is incomplete">
            {readiness.reasons.map((reason, i) => (
              <li key={i} className="flex items-start gap-1">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" aria-hidden="true" />
                {reason}
              </li>
            ))}
          </ul>
        )}

        {/* Hard blockers — never approvable away */}
        {projection.blockers.length > 0 && (
          <div className="rounded-md border border-red-500/20 bg-red-500/5 p-2">
            <p className="text-[11px] font-medium text-red-600">Blockers (re-research to resolve)</p>
            <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              {projection.blockers.map((b, i) => (
                <li key={`${b.kind}-${i}`}>
                  {b.label}
                  {b.detail ? <span className="text-muted-foreground/70"> — {b.detail}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Reviewable areas */}
        <ul className="space-y-2">
          {projection.areas.map((area) => {
            const current = currentDecisionForArea(area, projection, events);
            const priorStale = events.find((e) => e.area === area.key && isStaleEvent(e, projection));
            const areaPending = pending?.startsWith(`${area.key}:`);
            return (
              <li key={area.key} className="rounded-md border p-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{area.label}</p>
                    {area.value !== undefined && (
                      <p className="truncate text-xs text-muted-foreground" title={area.value}>
                        {area.value}
                      </p>
                    )}
                  </div>
                  {current ? (
                    <Badge variant="outline" className={cn('text-[10px]', DECISION_CLASS[current.decision])}>
                      {DECISION_LABEL[current.decision]} · {formatWhen(current.createdAt)}
                    </Badge>
                  ) : priorStale ? (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      Prior review is stale
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      Not reviewed
                    </Badge>
                  )}
                </div>

                {/* Audit trail — who / when / note for the current decision. */}
                {current && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Reviewed by {current.reviewerId} · {formatWhen(current.createdAt)}
                    {current.note ? <span className="italic"> — “{current.note}”</span> : null}
                  </p>
                )}

                {/* Safe source references */}
                {area.sourceReceipts.length > 0 && (
                  <ul
                    className="mt-1 space-y-0.5 text-[11px] text-muted-foreground"
                    aria-label={`Sources for ${area.label}`}
                  >
                    {area.sourceReceipts.map((receipt) => {
                      const safe = receipt.url ? canonicalHttpUrl(receipt.url)?.displayUrl : undefined;
                      return (
                        <li key={receipt.identity} className="break-words">
                          {safe ? (
                            <a
                              href={safe}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                            >
                              {receipt.label}
                              <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
                            </a>
                          ) : (
                            <span>{receipt.label}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* Optional note */}
                <label className="sr-only" htmlFor={`review-note-${area.key}`}>
                  Review note for {area.label}
                </label>
                <div className="mt-2 flex items-start gap-1">
                  <Pencil className="mt-2 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <Textarea
                    id={`review-note-${area.key}`}
                    value={notes[area.key] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [area.key]: e.target.value }))}
                    placeholder="Optional note…"
                    rows={1}
                    className="min-h-8 text-xs"
                    disabled={staleBlocked}
                  />
                </div>

                {areaErrors[area.key] && <p className="mt-1 text-[11px] text-red-600">{areaErrors[area.key]}</p>}

                {/* Actions */}
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label={`Approve ${area.label}`}
                    disabled={areaPending || staleBlocked}
                    onClick={() => submit(area, 'approved')}
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label={`Reject ${area.label}`}
                    disabled={areaPending || staleBlocked}
                    onClick={() => submit(area, 'rejected')}
                  >
                    <XCircle className="mr-1 h-3 w-3" aria-hidden="true" />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label={`Mark ${area.label} as needs changes`}
                    disabled={areaPending || staleBlocked}
                    onClick={() => submit(area, 'needs_changes')}
                  >
                    Needs changes
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>

        {/*
          Separate, explicit promotion action — distinct from recording a decision.
          ONLY structured drafts are promotable (a narrative draft is reviewed for
          trust, never written onto Company fields), and ONLY when the WHOLE draft is
          ready — matching the server's ready-only gate, so the button can't offer an
          action the server would refuse.
        */}
        {projection.artifactKind === 'structured' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
              <p className="text-[11px] text-muted-foreground">
                Promotion writes approved values onto the company. It is a separate, explicit step, available once the
                whole draft is approved.
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-xs"
                disabled={promote.isPending || !readiness.ready || staleBlocked}
                onClick={() =>
                  promote.mutate(undefined, {
                    onError: () => undefined,
                  })
                }
              >
                {promote.isPending ? 'Promoting…' : 'Promote approved fields'}
              </Button>
            </div>
            {promote.isError && (
              <p className="text-[11px] text-red-600">
                {promote.error instanceof Error ? promote.error.message : 'Promotion failed'}
              </p>
            )}
            {promote.isSuccess && promote.data?.promoted?.length ? (
              <p
                className={cn('text-[11px]', promote.data.graphSync === 'failed' ? 'text-amber-600' : 'text-green-600')}
              >
                Promoted: {promote.data.promoted.join(', ')}
                {graphSyncNote(promote.data.graphSync)}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
