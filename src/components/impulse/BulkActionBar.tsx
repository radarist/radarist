/**
 * @file BulkActionBar.tsx
 * @description Bulk-selection surface for the insights table — a thin
 * wrapper over the shared floating `BulkActionToolbar` (bottom of the
 * viewport, same surface as companies/signals/linker/infographics).
 *
 * Owns:
 *
 *   - The "Dismiss N" CTA (thumbs-down) that opens `<BulkDismissDialog>`
 *     (Q3 copy), passed to the toolbar via `additionalActions`.
 *   - The optimistic snackbar with Undo on bulk dismiss — symmetric to
 *     the single-row dismiss flow in `InsightTableRow`, except the
 *     mutation hook (`useBulkDismissInsights`) restores via the carried
 *     insight objects, not a fresh refetch.
 *
 * The selection count + clear-selection X come from the shared toolbar
 * itself (`entityType="insight"`). Selection state stays lifted at the
 * feed layer (`BriefingFeed`) — this component only reads it.
 *
 * @updated 2026-06-10 - Aligned with canonical library-table conventions:
 *   replaced the page-local top action bar with the shared floating
 *   BulkActionToolbar; the dismiss handler + confirmation dialog are
 *   unchanged.
 */

'use client';

import { useState } from 'react';
import { ThumbsDown } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { BulkActionToolbar } from '@/components/bulk-actions';
import { useBulkDismissInsights } from '@/hooks/queries/useBulkDismissInsights';
import { BulkDismissDialog } from './BulkDismissDialog';
import type { BriefingInsight } from '@/hooks/useBriefing';

const UNDO_DURATION_MS = 5_000;

interface BulkActionBarProps {
  /** The currently selected insights (full objects, not just IDs). */
  selectedInsights: BriefingInsight[];
  /** Clear the parent's selection set. */
  onClearSelection: () => void;
}

export function BulkActionBar({ selectedInsights, onClearSelection }: BulkActionBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const bulk = useBulkDismissInsights();

  if (selectedInsights.length === 0) return null;

  const count = selectedInsights.length;
  const plural = count === 1 ? 'insight' : 'insights';

  const handleConfirm = () => {
    // Capture the snapshot list for undo BEFORE firing the mutation —
    // once the optimistic remove lands, the rows are gone from cache.
    const snapshot = [...selectedInsights];
    bulk.mutate(
      { dismiss: true, insightIds: snapshot.map((i) => i.id) },
      {
        onSuccess: () => {
          setDialogOpen(false);
          onClearSelection();
          toast.success(`${count} ${plural} marked as read`, {
            duration: UNDO_DURATION_MS,
            action: {
              label: 'Undo',
              onClick: () => bulk.mutate({ dismiss: false, insights: snapshot }),
            },
          });
        },
        onError: (err) => {
          setDialogOpen(false);
          toast.error('Failed to mark as read', { description: err.message });
        },
      }
    );
  };

  return (
    <>
      <BulkActionToolbar
        selectedCount={count}
        entityType="insight"
        onClearSelection={onClearSelection}
        additionalActions={
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setDialogOpen(true)}
            data-testid="bulk-action-bar-dismiss"
            disabled={bulk.isPending}
          >
            <ThumbsDown className="h-3.5 w-3.5 mr-2" />
            Dismiss {count}
          </Button>
        }
      />

      <BulkDismissDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        count={count}
        onConfirm={handleConfirm}
        disabled={bulk.isPending}
      />
    </>
  );
}
