/**
 * @file InsightTypeBadge.tsx
 * @description Small semantic badge for a `BriefingInsight.type` value.
 *
 * Visual grammar copied from `SignalStatusBadge` in
 * `src/app/triage/signals/page.tsx` (outline badge + per-state tinted
 * background + matching text color). Keeps the briefing table looking
 * like the signals table without a custom color system.
 *
 * Variants:
 *   discovery       → yellow  (a new thing surfaced)
 *   connection      → blue    (graph edge surfaced)
 *   pattern         → emerald (trend / repeat observation)
 *   scoring_change  → purple  (relevance shifted)
 *   narrative       → indigo  (interpreted impact story)
 *
 * Unknown / future types fall back to a muted outline so the row never
 * breaks if the server-side enum grows.
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { BriefingInsight } from '@/hooks/useBriefing';

// Keyed by lowercased type so it tolerates server enum casing (e.g. "Constraint").
const TYPE_META: Record<string, { label: string; className: string }> = {
  discovery: {
    label: 'Discovery',
    className: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
  },
  connection: {
    label: 'Connection',
    className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  },
  pattern: {
    label: 'Pattern',
    className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  },
  scoring_change: {
    label: 'Scoring change',
    className: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  },
  constraint: {
    label: 'Constraint',
    className: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30',
  },
  narrative: {
    label: 'Narrative',
    className: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
  },
};

interface InsightTypeBadgeProps {
  type: BriefingInsight['type'] | string;
  className?: string;
}

export function InsightTypeBadge({ type, className }: InsightTypeBadgeProps) {
  const meta = TYPE_META[String(type).toLowerCase()];
  if (meta) {
    return (
      <Badge variant="outline" className={cn('gap-1 px-2 py-0.5 text-xs font-normal', meta.className, className)}>
        {meta.label}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 px-2 py-0.5 text-xs font-normal bg-muted text-muted-foreground', className)}
    >
      {type.charAt(0).toUpperCase() + type.slice(1)}
    </Badge>
  );
}
