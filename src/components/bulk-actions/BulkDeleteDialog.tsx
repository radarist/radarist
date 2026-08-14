/**
 * @file components/bulk-actions/BulkDeleteDialog.tsx
 * @description Confirmation dialog for bulk delete operations.
 *
 * Shows a warning about the destructive action and cascade effects.
 * Requires explicit confirmation before proceeding.
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export interface BulkDeleteDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Called when dialog should close */
  onOpenChange: (open: boolean) => void;
  /** Number of items to delete */
  count: number;
  /** Entity type for display (e.g., "company", "technology") */
  entityType: string;
  /** Called when user confirms deletion. Return false to keep the dialog open for retry. */
  onConfirm: () => Promise<void | boolean>;
  /** Whether to show cascade warning about relations */
  showCascadeWarning?: boolean;
}

/**
 * Confirmation dialog for bulk delete operations.
 *
 * @example
 * ```tsx
 * <BulkDeleteDialog
 *   open={showDeleteDialog}
 *   onOpenChange={setShowDeleteDialog}
 *   count={selectedIds.length}
 *   entityType="company"
 *   onConfirm={handleBulkDelete}
 *   showCascadeWarning={true}
 * />
 * ```
 */
export function BulkDeleteDialog({
  open,
  onOpenChange,
  count,
  entityType,
  onConfirm,
  showCascadeWarning = true,
}: BulkDeleteDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  // Pluralize entity type (handle irregular plurals)
  const entityLabel = count === 1
    ? entityType
    : entityType.endsWith('y')
      ? `${entityType.slice(0, -1)}ies`
      : entityType.endsWith('s') || entityType.endsWith('x') || entityType.endsWith('ch') || entityType.endsWith('sh')
        ? `${entityType}es`
        : `${entityType}s`;
  const entityLabelCapitalized = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);

  const handleConfirm = async () => {
    setIsDeleting(true);
    try {
      const shouldClose = await onConfirm();
      if (shouldClose !== false) {
        onOpenChange(false);
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <AlertDialogTitle>
              Delete {count} {entityLabel}?
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                This action cannot be undone. {entityLabelCapitalized} will be permanently deleted
                from the database.
              </p>
              {showCascadeWarning && (
                <p>
                  <strong>Note:</strong> All relations connected to these {entityLabel} will also
                  be removed.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4 mr-2" />
                Delete {count} {entityLabel}
              </>
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
