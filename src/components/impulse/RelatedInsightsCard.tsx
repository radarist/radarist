/**
 * @file RelatedInsightsCard.tsx
 * @description Main-column card for the insight detail page (Task 20 /
 * P-D4) — surfaces up to 5 OTHER insights that are either the same `type`
 * as the current one or share at least one linked entity. Filtered
 * entirely client-side over the already-fetched `useBriefing` list — no
 * new backend endpoint. Clicking a row navigates to that insight's own
 * detail page.
 */

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InsightTypeBadge } from './InsightTypeBadge';
import { displayInsightTitle } from '@/lib/graph/insight-actions';
import type { BriefingInsight } from '@/hooks/useBriefing';

interface RelatedInsightsCardProps {
  current: BriefingInsight;
  /** The full (already-fetched) insights list — e.g. from `useBriefing()`. */
  allInsights: BriefingInsight[];
  /** Max rows to render. Defaults to 5 per the Task 20 spec. */
  limit?: number;
}

/**
 * Pure filter — kept separate from the component so it's trivially
 * testable without mounting anything. Same-type OR shares a linked entity
 * with `current`, excluding `current` itself, capped at `limit`.
 */
export function selectRelatedInsights(
  current: BriefingInsight,
  allInsights: BriefingInsight[],
  limit = 5
): BriefingInsight[] {
  const currentEntityIds = new Set(current.relatedEntities.map((e) => e.id));
  return allInsights
    .filter((i) => i.id !== current.id)
    .filter((i) => i.type === current.type || i.relatedEntities.some((e) => currentEntityIds.has(e.id)))
    .slice(0, limit);
}

export function RelatedInsightsCard({ current, allInsights, limit = 5 }: RelatedInsightsCardProps) {
  const router = useRouter();
  const related = useMemo(() => selectRelatedInsights(current, allInsights, limit), [current, allInsights, limit]);

  if (related.length === 0) return null;

  return (
    <Card data-testid="related-insights-card">
      <CardHeader>
        <CardTitle className="text-base">Related insights</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {related.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => router.push(`/triage/insights/${i.id}`)}
            className="flex items-center gap-2 rounded-lg p-2 text-left transition-colors hover:bg-muted/50"
            data-testid={`related-insight-${i.id}`}
          >
            <InsightTypeBadge type={i.type} />
            <span className="truncate text-sm">{displayInsightTitle(i.title)}</span>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
