'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search, Sparkles, TrendingUp, Link2, X } from 'lucide-react';
import type { BriefingInsight } from '@/hooks/useBriefing';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { getInsightAction, displayInsightTitle } from '@/lib/graph/insight-actions';

interface InsightCardProps {
  insight: BriefingInsight;
  onDismiss: (insightId: string) => void;
}

const TYPE_ICONS = {
  discovery: Search,
  connection: Link2,
  pattern: TrendingUp,
  scoring_change: TrendingUp,
  narrative: Sparkles,
} as const;

export function InsightCard({ insight, onDismiss }: InsightCardProps) {
  const router = useRouter();
  const Icon = TYPE_ICONS[insight.type] ?? Search;

  // For 'connection' insights, prefer the explicit observedEntityId (the
  // newly-discovered entity) over relatedEntities[0] — the latter comes
  // from a non-deterministic Neo4j collect() and could point at the
  // explored side, the observed side, or any other ABOUT-linked node.
  // Falls back to relatedEntities[0] for older insights and non-connection
  // types that don't carry the explicit endpoint properties.
  const primaryEntityId = insight.observedEntityId ?? insight.relatedEntities[0]?.id;
  const primaryEntity = primaryEntityId
    ? (insight.relatedEntities.find((e) => e.id === primaryEntityId) ?? insight.relatedEntities[0])
    : undefined;

  // Phase 0 step 0.10 navigation fix: prefer the persisted `actionUrl`
  // (e.g. `/library/companies?sheet=comp-ibm`) over the legacy
  // `openSheet(id)` call. openSheet only writes `?sheet=<id>` to the
  // current route, and /briefing has no sheet container — the user saw
  // nothing happen. The unified `getInsightAction` helper is the
  // fallback for older insights that pre-date persisted actionUrls.
  const fallback = primaryEntity ? getInsightAction(primaryEntity.type, primaryEntity.id) : null;
  const targetUrl = insight.actionUrl ?? fallback?.actionUrl ?? null;

  return (
    <Card data-testid={`insight-card-${insight.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">{displayInsightTitle(insight.title)}</CardTitle>
          </div>
          <Badge variant="outline">{Math.round(insight.confidenceScore * 100)}%</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-3">{insight.summary}</p>
        <div className="flex gap-2">
          {targetUrl && (
            <Button
              size="sm"
              variant="default"
              data-testid={`insight-view-${insight.id}`}
              onClick={() => {
                router.push(targetUrl);
                // Track engagement (fire-and-forget). The route derives
                // the per-topic preference from the insight's entity types
                // server-side after step 0.1 — we only pass the action.
                fetchWithAuth('/api/graph/preference', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ insightId: insight.id, action: 'clicked' }),
                }).catch(() => {});
              }}
            >
              {insight.actionLabel ?? fallback?.actionLabel ?? 'View entity'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            data-testid={`insight-dismiss-${insight.id}`}
            onClick={() => onDismiss(insight.id)}
          >
            <X className="h-3 w-3 mr-1" />
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
