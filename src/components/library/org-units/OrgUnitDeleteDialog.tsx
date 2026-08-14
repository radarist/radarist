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

interface OrgUnitDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgUnitName?: string;
  childCount: number;
  isPending?: boolean;
  onConfirm: () => void;
}

export function OrgUnitDeleteDialog({
  open,
  onOpenChange,
  orgUnitName,
  childCount,
  isPending = false,
  onConfirm,
}: OrgUnitDeleteDialogProps) {
  const hasKnownChildren = childCount > 0;
  const displayName = orgUnitName ? `\"${orgUnitName}\"` : 'This org unit';
  const childLabel = childCount === 1 ? 'child org unit' : 'child org units';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete org unit?</AlertDialogTitle>
          <AlertDialogDescription>
            {hasKnownChildren
              ? `${displayName} cannot be deleted because it has ${childCount} ${childLabel}. Reassign its children and any initiatives it owns before trying again.`
              : `${displayName} will be permanently deleted. Deletion is blocked while it has child org units or owns initiatives, so reassign those records first.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={hasKnownChildren || isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
