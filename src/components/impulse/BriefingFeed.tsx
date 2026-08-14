/**
 * @file BriefingFeed.tsx
 * @description Container for the briefing list — toolbar + body + token
 * usage bar. The body is `InsightTable` by default (Option A Chunk 4) and
 * falls back to the card grid behind a view-mode toggle for parity with
 * the signals page.
 *
 * Filters applied client-side over the already-fetched insights from
 * `useBriefing` — the route returns the full unconsumed set so no
 * additional fetch is needed when the user narrows the view.
 *
 * Empty states differentiate "no insights at all" (the inbox is clean)
 * from "filters exclude everything visible" (the user can clear them).
 */

'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Filter, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useBriefing, BriefingRequestError, type BriefingErrorKind, type BriefingInsight } from '@/hooks/useBriefing';
import { Button } from '@/components/ui/button';
import { CardGridSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/feedback/EmptyState';

import { BriefingToolbar, useBriefingFilters } from './BriefingToolbar';
import { BriefingEmptyState } from './BriefingEmptyState';
import { InsightTable } from './InsightTable';
import { InsightCard } from './InsightCard';
import { BulkActionBar } from './BulkActionBar';
import { useBriefingUIStore } from '@/stores/briefing-ui-store';
import { useDismissInsight } from '@/hooks/queries/useDismissInsight';
import { useUndismissInsight } from '@/hooks/queries/useUndismissInsight';
import { useLikeInsight } from '@/hooks/queries/useLikeInsight';
import { useBriefingKeyboardShortcuts } from '@/hooks/useBriefingKeyboardShortcuts';

const UNDO_DURATION_MS = 5_000;

/**
 * Apply the current filter set to a list of insights. Pure function so
 * the feed can memoise it and the test suite can pin behaviour without
 * mounting the toolbar.
 */
export function applyBriefingFilters(
  insights: BriefingInsight[],
  filters: {
    types: string[];
    agents: string[];
    minConfidence: number;
    likedOnly: boolean;
    /** Client-side title/summary substring match (case-insensitive). Optional — omitting it
     * (or passing '') is a no-op, so existing callers/tests that predate the search box
     * keep working unchanged. */
    search?: string;
  }
): BriefingInsight[] {
  const query = (filters.search ?? '').trim().toLowerCase();
  return insights.filter((insight) => {
    if (filters.types.length > 0 && !filters.types.includes(insight.type)) return false;
    if (filters.agents.length > 0 && !filters.agents.includes(insight.agentName)) return false;
    if (insight.confidenceScore < filters.minConfidence) return false;
    if (filters.likedOnly && !insight.liked) return false;
    if (
      query &&
      !insight.title.toLowerCase().includes(query) &&
      !(insight.summary ?? '').toLowerCase().includes(query)
    ) {
      return false;
    }
    return true;
  });
}

export function BriefingFeed() {
  // `isPending` (not `isLoading`) keeps the skeleton visible while the
  // useBriefing query is gated on auth-state restoration (Phase 0 step
  // 0.10 contract). Using `isLoading` would flash the empty state.
  // `isError` (UX-018) distinguishes a graph outage from an empty inbox.
  const { data, isPending, isError, error, refetch } = useBriefing();
  const viewMode = useBriefingUIStore((s) => s.viewMode);
  const router = useRouter();
  const dismiss = useDismissInsight();
  const undismiss = useUndismissInsight();
  const like = useLikeInsight();
  const { filters, clearAll } = useBriefingFilters();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Client-side title/summary search — deliberately local (not URL-synced like the
  // four BriefingToolbar filters) to match the Signals/Assessments search-box pattern.
  const [search, setSearch] = useState('');
  const clearAllFilters = useCallback(() => {
    clearAll();
    setSearch('');
  }, [clearAll]);

  const insights = data?.insights ?? [];

  // Pull distinct types and agents from the full list so the toolbar
  // only ever shows filter options that match real data.
  const { availableTypes, availableAgents } = useMemo(() => {
    const types = new Set<string>();
    const agents = new Set<string>();
    for (const i of insights) {
      types.add(i.type);
      agents.add(i.agentName);
    }
    return {
      availableTypes: Array.from(types),
      availableAgents: Array.from(agents),
    };
  }, [insights]);

  const filteredInsights = useMemo(
    () => applyBriefingFilters(insights, { ...filters, search }),
    [insights, filters, search]
  );

  // Keep keyboard shortcuts bound against the *filtered* list so ↑/↓
  // navigates only the rows the user can actually see. The hook owns
  // the focused-row state and we pass it through to the table.
  const { focusedId } = useBriefingKeyboardShortcuts({
    insights: filteredInsights,
    enabled: filteredInsights.length > 0 && viewMode === 'table',
    actions: {
      onLike: (i) => like.mutate({ insightId: i.id, liked: !i.liked }),
      onDismiss: (i) => {
        // Single-row dismiss with Undo snackbar — mirrors the row's own
        // dismiss flow so keyboard and mouse paths produce identical UX.
        const snapshot = { ...i };
        dismiss.mutate(
          { insightId: i.id },
          {
            onSuccess: () => {
              toast.success('Insight dismissed', {
                duration: UNDO_DURATION_MS,
                action: {
                  label: 'Undo',
                  onClick: () => undismiss.mutate({ insight: snapshot }),
                },
              });
            },
            onError: (err) => {
              toast.error('Failed to dismiss insight', { description: err.message });
            },
          }
        );
      },
      onOpen: (i) => router.push(`/triage/insights/${i.id}`),
    },
  });

  // The full insight objects for the currently-selected ids. Threaded
  // into BulkActionBar (the shared floating bottom toolbar) so its Undo
  // snackbar can restore the same rows without a refetch.
  const selectedInsights = useMemo(
    () => filteredInsights.filter((i) => selectedIds.has(i.id)),
    [filteredInsights, selectedIds]
  );

  const clearSelection = () => setSelectedIds(new Set());

  if (isPending) return <CardGridSkeleton columns={1} cards={3} />;

  // UX-018: an outage is NOT an empty inbox. Surface the failure distinctly
  // with a retry, instead of the misleading "no insights" state below.
  // UX-046: only when there is nothing cached — with last-good data in hand,
  // the feed keeps rendering it and shows a stale-data note instead (below).
  if (isError && !data) {
    return (
      <div data-testid="briefing-unavailable">
        <PageHeaderRow />
        <BriefingUnavailable error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  // Distinguish the empty states:
  //   - server returned 0 insights → UX-051 truthful pipeline state
  //     (no-exploration / paused / pending / quiet / outage — each with the
  //     exact action that can advance it, no "agents are working" claim)
  //   - filtered set is 0 with filters active → "narrow your filters" (below)
  if (insights.length === 0) {
    return (
      <div data-testid="briefing-empty">
        <PageHeaderRow />
        <BriefingEmptyState />
      </div>
    );
  }

  return (
    <div data-testid="briefing-feed">
      {isError && (
        // UX-046 last-good contract: a failed background refetch must not
        // blank rows the user already had. Keep the data, say it's stale.
        <div
          data-testid="stale-data-note"
          role="status"
          className="flex items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Live refresh failed — showing the last loaded insights.</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => refetch()}>
            <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
            Retry
          </Button>
        </div>
      )}
      {/*
       * Single header row, mirroring the Linker page: title block on
       * the left, filter controls on the right, separated by a single
       * `border-b`. The previous layout split title and toolbar into
       * two rows which read as a "double header" against the page
       * card chrome.
       */}
      <PageHeaderRow>
        <BriefingToolbar
          availableTypes={availableTypes}
          availableAgents={availableAgents}
          searchValue={search}
          onSearchChange={setSearch}
        />
      </PageHeaderRow>

      {filteredInsights.length === 0 ? (
        <div data-testid="briefing-empty-filtered" className="p-4">
          <EmptyState
            icon={Filter}
            title="No insights match these filters"
            description={`${insights.length} insight${insights.length === 1 ? '' : 's'} are hidden by the current filters. Clear or widen the filters to see them.`}
            action={{ label: 'Clear filters', onClick: clearAllFilters }}
          />
        </div>
      ) : viewMode === 'card' ? (
        <div className="p-4">
          <CardListBody insights={filteredInsights} onDismiss={(id) => dismiss.mutate({ insightId: id })} />
        </div>
      ) : (
        <InsightTable
          insights={filteredInsights}
          selectedIds={selectedIds}
          onSelectedIdsChange={setSelectedIds}
          focusedId={focusedId}
        />
      )}

      {/* Bulk Action Toolbar — shared floating bottom toolbar (same surface
          as companies/signals/linker/infographics). Dismiss opens the same
          BulkDismissDialog the old top bar used; the built-in X clears the
          selection. Renders null while nothing is selected. */}
      <BulkActionBar selectedInsights={selectedInsights} onClearSelection={clearSelection} />
    </div>
  );
}

/**
 * UX-018 — distinct "insights unavailable" state. Copy varies by failure kind
 * so a rate-limit and an auth lapse don't read as a backend outage. Retry
 * re-runs the (bounded) query rather than showing an empty inbox.
 */
const UNAVAILABLE_COPY: Record<BriefingErrorKind, { title: string; description: string }> = {
  unavailable: {
    title: 'Insights are temporarily unavailable',
    description:
      "We couldn't reach the insights service. Your data is safe — this is a connection issue, not an empty inbox. Try again in a moment.",
  },
  'rate-limited': {
    title: 'Too many requests',
    description: "You've hit the rate limit for insights. Wait a moment, then retry.",
  },
  unauthorized: {
    title: 'Your session expired',
    description: 'Sign back in to view your insights, then retry.',
  },
  error: {
    title: "Couldn't load insights",
    description: 'Something went wrong loading your insights. Try again — if it persists, check back shortly.',
  },
};

function BriefingUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const kind: BriefingErrorKind = error instanceof BriefingRequestError ? error.kind : 'error';
  const copy = UNAVAILABLE_COPY[kind];
  return (
    <div className="p-4">
      <EmptyState
        icon={AlertTriangle}
        title={copy.title}
        description={copy.description}
        action={{ label: 'Retry', onClick: onRetry, icon: RefreshCw }}
      />
    </div>
  );
}

function PageHeaderRow({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 p-4 border-b border-border lg:flex-row lg:items-center lg:justify-between">
      <div className="space-y-1 shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
        <p className="text-sm text-muted-foreground">Recent insights from your agents</p>
      </div>
      {children && <div className="flex flex-col gap-3 sm:flex-row sm:items-center">{children}</div>}
    </div>
  );
}

/**
 * Legacy card-grid body, kept for the optional `viewMode: 'card'`
 * preference. Reuses the existing `InsightCard` component unchanged
 * (Phase 0 already rewrote its click + dismiss wiring) but routes
 * dismiss through the same `useDismissInsight` hook the table uses, so
 * both surfaces produce identical optimistic + undo behaviour.
 */
function CardListBody({
  insights,
  onDismiss,
}: {
  insights: BriefingInsight[];
  onDismiss: (insightId: string) => void;
}) {
  return (
    <div className="space-y-4" data-testid="briefing-card-list">
      {insights.map((insight) => (
        <InsightCard key={insight.id} insight={insight} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
