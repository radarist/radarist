/**
 * @file components/activity/RunsDegradedBanner.tsx
 * @description Partial-degradation banner for the `/agents/runs` list
 * (ARUN-012 / ARUN-013).
 *
 * The runs list draws from four independent sources (history, build missions,
 * in-flight missions, the live SSE stream). When SOME of them fail but others
 * still return rows, hiding the failure would make a partial outage read as a
 * shorter — but complete — list. This banner sits above the still-rendered
 * table and names exactly which sources are unavailable, with a Retry that
 * refetches them, so a partial failure is never mistaken for the whole truth.
 */
'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Join source labels into a natural-language list ("a", "a and b", "a, b, and c"). */
function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

export interface RunsDegradedBannerProps {
  /** Human-readable labels of the degraded sources (see `degradedRunSources`). */
  sources: string[];
  /** Refetch the failed sources. */
  onRetry: () => void;
  className?: string;
}

/**
 * Renders nothing when every source is healthy — the caller can mount it
 * unconditionally and let it decide.
 */
export function RunsDegradedBanner({ sources, onRetry, className }: RunsDegradedBannerProps) {
  if (sources.length === 0) return null;
  const verb = sources.length === 1 ? 'is' : 'are';

  return (
    <div
      role="status"
      data-testid="runs-degraded-banner"
      className={cn(
        'mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 text-sm',
        'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        className
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Some runs may be missing — {joinLabels(sources)} {verb} temporarily unavailable.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="runs-degraded-retry"
        onClick={onRetry}
        className="h-7 shrink-0 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
      >
        Retry
      </Button>
    </div>
  );
}
