/**
 * @file BulkDismissDialog.tsx
 * @description Confirmation dialog for bulk-dismiss.
 *
 * Carries the Q3 disclaimer verbatim from the plan:
 *
 *   "Mark {N} insights as read. This won't tell agents to find fewer of them."
 *
 * The phrasing is deliberate — bulk dismiss is housekeeping, not a
 * judgement. The disclaimer keeps users from over-attributing agent
 * behaviour to a "mark all as read" click. The endpoint backs this
 * contract by skipping preference writes on bulk; the dialog surfaces
 * the contract to the user.
 *
 * Open / close state is controlled by the parent so the dialog can be
 * driven by either the toolbar button (BulkActionBar) or a keyboard
 * shortcut without duplicating state.
 */

'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface BulkDismissDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  onConfirm: () => void;
  /** Disables the confirm button while the bulk mutation is in flight. */
  disabled?: boolean;
}

export function BulkDismissDialog({ open, onOpenChange, count, onConfirm, disabled }: BulkDismissDialogProps) {
  const plural = count === 1 ? 'insight' : 'insights';
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="bulk-dismiss-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Mark {count} {plural} as read
          </AlertDialogTitle>
          <AlertDialogDescription data-testid="bulk-dismiss-disclaimer">
            This won&apos;t tell agents to find fewer of them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="bulk-dismiss-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={disabled} data-testid="bulk-dismiss-confirm">
            Mark as read
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
