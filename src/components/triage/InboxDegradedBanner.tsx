/**
 * @file components/triage/InboxDegradedBanner.tsx
 * @description Partial-degradation banner for the Assessment inbox (UX-053).
 *
 * The inbox joins three independent sources (discoveries, report
 * recommendations, verdicts). When SOME fail but others still return rows,
 * hiding the failure would make a partial outage read as a shorter — but
 * complete — inbox. This banner sits above the still-rendered table, names
 * which source classes are unavailable (labels only — never raw error text),
 * and offers a bounded Retry. Mirrors RunsDegradedBanner (`/agents/runs`),
 * kept separate so the runs DOM stays byte-identical.
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

export interface InboxDegradedBannerProps {
  /** Human-readable labels of the degraded sources (see `degradedInboxSources`). */
  sources: string[];
  /** Refetch the failed sources (bounded by the hook's retry cap). */
  onRetry: () => void;
  /** True once the bounded retry budget is spent — swaps the button for guidance. */
  retriesExhausted?: boolean;
  className?: string;
}

/**
 * Renders nothing when every source is healthy — the caller can mount it
 * unconditionally and let it decide.
 */
export function InboxDegradedBanner({ sources, onRetry, retriesExhausted, className }: InboxDegradedBannerProps) {
  if (sources.length === 0) return null;
  const verb = sources.length === 1 ? 'is' : 'are';

  return (
    <div
      role="status"
      data-testid="inbox-degraded-banner"
      className={cn(
        'mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 text-sm',
        'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        className
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Some inbox items may be missing — {joinLabels(sources)} {verb} temporarily unavailable.
      </p>
      {retriesExhausted ? (
        <span data-testid="inbox-degraded-exhausted" className="shrink-0 text-xs">
          Still unavailable — try again after reloading the page.
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="inbox-degraded-retry"
          onClick={onRetry}
          className="h-7 shrink-0 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
        >
          Retry
        </Button>
      )}
    </div>
  );
}
