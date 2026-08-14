/**
 * @file InsightTableRow.tsx
 * @description One row in the briefing InsightTable.
 *
 * Visual grammar follows the signals table row (per the 2026-05-13
 * design alignment): title + muted description, plain-text agent cell,
 * absolute date, signals-style ghost icon buttons with emerald (like) /
 * destructive (dismiss) hover treatment. Cells inherit `px-4 py-3` from
 * the table header definitions.
 *
 * Click-through model unchanged from Chunk 2: a plain row click
 * navigates to the detail page; selection / action buttons
 * stopPropagation so they don't double-trigger navigation.
 *
 * Selected rows render with `bg-primary/5` (signals' selection pattern)
 * instead of an outline ring. The keyboard-focused row uses `bg-accent`
 * so the two states stack without colliding.
 */

'use client';

import { useRouter } from 'next/navigation';
import { ThumbsUp, ThumbsDown, MoreHorizontal, ExternalLink, Copy } from 'lucide-react';
import { toast } from 'sonner';

import { TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { displayInsightTitle } from '@/lib/graph/insight-actions';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { formatEnumLabel } from '@/lib/enum-label';
import { safeFormatDate } from '@/lib/safe-format-date';

import { InsightTypeBadge } from './InsightTypeBadge';
import { useLikeInsight } from '@/hooks/queries/useLikeInsight';
import { useDismissInsight } from '@/hooks/queries/useDismissInsight';
import { useUndismissInsight } from '@/hooks/queries/useUndismissInsight';
import type { BriefingInsight } from '@/hooks/useBriefing';
import { cn } from '@/lib/utils';

interface InsightTableRowProps {
  insight: BriefingInsight;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  /**
   * Keyboard-focused row (from `useBriefingKeyboardShortcuts`).
   * Renders as a subtle background so the user knows which row `L` /
   * `D` / Enter will affect.
   */
  focused?: boolean;
}

/** Duration of the dismiss-undo snackbar in milliseconds. */
const UNDO_DURATION_MS = 5_000;

/** Absolute detected-at date for the row (CONV-DATE) — never relative, never throws on a malformed timestamp. */
function formatDetectedAt(createdAt: string): string {
  return safeFormatDate(createdAt, 'MMM d, yyyy');
}

// Tinted confidence pill — same tint thresholds + pill shape as Linker's and
// Assessments' `ConfidenceBadge` (CONV-BADGE). Copied rather than extracted:
// three near-identical 10-line copies is cheaper than a shared module for a
// recipe this small and this stable.
function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color =
    confidence >= 85
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      : confidence >= 70
        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
        : 'bg-destructive/10 text-destructive';
  return <span className={cn('rounded px-2 py-0.5 text-xs font-medium', color)}>{confidence}%</span>;
}

export function InsightTableRow({ insight, selected, onSelectedChange, focused }: InsightTableRowProps) {
  const router = useRouter();
  const like = useLikeInsight();
  const dismiss = useDismissInsight();
  const undismiss = useUndismissInsight();

  const goToDetail = () => router.push(`/triage/insights/${insight.id}`);

  const handleLikeToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    like.mutate({ insightId: insight.id, liked: !insight.liked });
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    const snapshot = { ...insight };
    // Per-call callbacks passed to `mutate` belong to this row's mutation
    // observer. The optimistic cache removal unmounts the row, so TanStack can
    // drop those callbacks before the request settles. Promise continuations
    // survive that unmount and keep the Undo/error feedback reliable; the
    // mutation hook still owns cache rollback and invalidation.
    void dismiss.mutateAsync({ insightId: insight.id }).then(
      () => {
        toast.success('Insight dismissed', {
          duration: UNDO_DURATION_MS,
          action: {
            label: 'Undo',
            onClick: () => undismiss.mutate({ insight: snapshot }),
          },
        });
      },
      (err: unknown) => {
        toast.error('Failed to dismiss insight', {
          description: err instanceof Error ? err.message : 'An unexpected error occurred',
        });
      }
    );
  };

  const handleCopyLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}/triage/insights/${insight.id}`;
    void navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied'),
      () => toast.error('Couldn’t copy link')
    );
  };

  const handleOpenSource = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (insight.actionUrl) {
      router.push(insight.actionUrl);
      // Record the act-through as a preference signal (mirrors InsightCard).
      // 2.1 label-integrity fix: the table is the dominant insight UI and its
      // act path was previously dropping the strongest positive label —
      // biasing the engagement corpus toward likes/views over real act-throughs.
      fetchWithAuth('/api/graph/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ insightId: insight.id, action: 'clicked' }),
      }).catch(() => {});
    }
  };

  // CONV-DATE: record tables show absolute dates (`MMM d, yyyy`), not the
  // browser-locale-dependent `toLocaleDateString()` format.
  const detectedAt = formatDetectedAt(insight.createdAt);
  const confidencePct = Math.round(insight.confidenceScore * 100);

  return (
    <TableRow
      data-testid={`insight-row-${insight.id}`}
      data-state={selected ? 'selected' : undefined}
      data-focused={focused ? 'true' : undefined}
      className={cn(
        'group cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
        selected && 'bg-primary/5',
        focused && !selected && 'bg-accent/50'
      )}
      onClick={goToDetail}
    >
      <TableCell className="w-[50px] px-4 py-3">
        <span onClick={(e) => e.stopPropagation()} className="inline-flex">
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelectedChange(v === true)}
            aria-label={`Select ${insight.title}`}
            data-testid={`insight-select-${insight.id}`}
          />
        </span>
      </TableCell>

      <TableCell className="px-4 py-3">
        <div className="flex flex-col">
          <span className="font-medium line-clamp-1 group-hover:text-primary transition-colors">
            {displayInsightTitle(insight.title)}
          </span>
          {insight.summary && (
            <span className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{insight.summary}</span>
          )}
        </div>
      </TableCell>

      <TableCell className="px-4 py-3">
        <InsightTypeBadge type={insight.type} />
      </TableCell>

      <TableCell className="px-4 py-3">
        {/* CONV-ENUM + CONV-BADGE: agent slugs (e.g. "narrative-synthesizer") get a human
            label in a neutral classification pill — same shape as the library
            classification pills and the Linker relation-type pill. */}
        <Badge variant="outline" className="text-xs font-normal">
          {formatEnumLabel(insight.agentName)}
        </Badge>
      </TableCell>

      <TableCell className="px-4 py-3">
        <ConfidenceBadge confidence={confidencePct} />
      </TableCell>

      <TableCell className="px-4 py-3 text-sm text-muted-foreground">{detectedAt}</TableCell>

      <TableCell className="w-[50px] px-4 py-3">
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              insight.liked
                ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 hover:text-emerald-600'
                : 'text-muted-foreground hover:bg-emerald-100 dark:hover:bg-emerald-950 hover:text-emerald-600'
            )}
            onClick={handleLikeToggle}
            aria-label={insight.liked ? 'Remove like' : 'Like insight'}
            data-testid={`insight-like-${insight.id}`}
            title={insight.liked ? 'Remove like' : 'Like'}
          >
            <ThumbsUp className={cn('h-4 w-4', insight.liked && 'fill-current')} />
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={handleDismiss}
            aria-label="Dismiss insight"
            data-testid={`insight-dismiss-${insight.id}`}
            title="Dismiss"
          >
            <ThumbsDown className="h-4 w-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                aria-label="More actions"
                data-testid={`insight-menu-${insight.id}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {insight.actionUrl && (
                <DropdownMenuItem onClick={handleOpenSource} data-testid={`insight-act-${insight.id}`}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {insight.actionLabel ?? 'View source entity'}
                </DropdownMenuItem>
              )}
              {insight.actionUrl && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={handleCopyLink}>
                <Copy className="h-4 w-4 mr-2" />
                Copy link to insight
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}
