'use client';

/**
 * @file components/library/companies/CompanyReviewQueue.tsx
 * @description AI-043 — a truthful, navigable Company research review queue/facet.
 * Surfaces only companies whose research draft is GENUINELY INCOMPLETE for the
 * current caller (not merely "has any artifact"), labelled with why — not
 * reviewed / partially reviewed / blocked / stale — and links each directly to
 * its Research-tab review panel. A completed (ready) or draft-less company leaves
 * the queue. The caller's per-company status is derived server-side in ONE
 * authenticated batch request (no N+1).
 */

import * as React from 'react';
import { ClipboardCheck, ChevronDown, ChevronRight } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { deriveCompanyResearchPresentation, isCompanyResearchDraft } from '@/lib/company-research-presentation';
import { isIncompleteReviewStatus, type CompanyReviewStatus } from '@/lib/company-review';
import { useCompanyReviewSummaries } from '@/hooks/queries/useCompanyReview';
import type { Company } from '@/lib/types';

const STATUS_LABEL: Record<CompanyReviewStatus, string> = {
  none: 'No draft',
  not_reviewed: 'Not reviewed',
  partial: 'Partially reviewed',
  blocked: 'Blocked',
  stale: 'Stale — refresh',
  ready: 'Ready',
};

const STATUS_CLASS: Record<CompanyReviewStatus, string> = {
  none: 'text-muted-foreground',
  not_reviewed: 'text-muted-foreground',
  partial: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  blocked: 'bg-red-500/10 text-red-600 border-red-500/20',
  stale: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
  ready: 'bg-green-500/10 text-green-600 border-green-500/20',
};

export function CompanyReviewQueue({
  companies,
  onReview,
  defaultOpen = false,
}: {
  companies: Company[];
  onReview: (company: Company) => void;
  defaultOpen?: boolean;
}) {
  // Draft-bearing companies (client-derived). When there are none, render nothing
  // WITHOUT mounting the inner list — so the batch-status query (and its
  // QueryClient dependency) only runs when there is actually something to review.
  const draftCompanies = React.useMemo(
    () => companies.filter((company) => isCompanyResearchDraft(deriveCompanyResearchPresentation(company))),
    [companies]
  );
  if (draftCompanies.length === 0) return null;
  return <CompanyReviewQueueList draftCompanies={draftCompanies} onReview={onReview} defaultOpen={defaultOpen} />;
}

function CompanyReviewQueueList({
  draftCompanies,
  onReview,
  defaultOpen,
}: {
  draftCompanies: Company[];
  onReview: (company: Company) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  const draftIds = React.useMemo(() => draftCompanies.map((c) => c.id), [draftCompanies]);
  const { data: summaries, isLoading, isError, refetch } = useCompanyReviewSummaries(draftIds);

  // Only classify once statuses are actually known. We NEVER label a draft
  // "awaiting review" before its status has loaded — an unknown status is not an
  // incomplete review.
  const queue = React.useMemo(() => {
    if (!summaries) return [];
    return draftCompanies
      .map((company) => ({ company, status: summaries[company.id]?.status }))
      .filter((row) => row.status !== undefined && isIncompleteReviewStatus(row.status));
  }, [draftCompanies, summaries]);

  // Honest transient states: "checking" while loading, an explicit error with a
  // retry on failure — never a misleading count of drafts "awaiting review".
  if (isLoading) {
    return (
      <div className="border-b border-border p-4">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Checking review status…
        </p>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="border-b border-border p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Review status unavailable.</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (queue.length === 0) return null;

  return (
    <div className="border-b border-border p-4">
      <Collapsible open={open} onOpenChange={setOpen}>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
              aria-label={`Source review queue — ${queue.length} draft${queue.length === 1 ? '' : 's'} awaiting review`}
            >
              <ClipboardCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <span className="text-sm font-medium">Source review queue</span>
              <Badge variant="outline" className="text-[10px]">
                {queue.length} awaiting review
              </Badge>
              <span className="ml-auto">
                {open ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                )}
              </span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <ul className="divide-y divide-border/60">
                {queue.map(({ company, status }) => (
                  <li key={company.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{company.name}</p>
                      <p className="text-[11px] text-muted-foreground">AI research draft — source review required</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {status && (
                        <Badge variant="outline" className={`text-[10px] ${STATUS_CLASS[status]}`}>
                          {STATUS_LABEL[status]}
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        aria-label={`Review ${company.name}`}
                        onClick={() => onReview(company)}
                      >
                        Review
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
