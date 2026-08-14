'use client'

import * as React from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface EntitySheetFooterProps {
  /** Mode: create or edit */
  mode: 'create' | 'edit'
  /** Callback when cancel is clicked */
  onCancel: () => void
  /** Callback when save is clicked */
  onSave: () => void
  /** Callback when delete is clicked (edit mode only) */
  onDelete?: () => void
  /** Whether save is in progress */
  isSaving?: boolean
  /** Whether delete is in progress */
  isDeleting?: boolean
  /** Whether the form is dirty (has unsaved changes) */
  isDirty?: boolean
  /** Whether the form is valid */
  isValid?: boolean
  /** Custom save button label */
  saveLabel?: string
  /** Custom cancel button label */
  cancelLabel?: string
  /** Entity name for delete confirmation */
  entityName?: string
  /** Entity-specific delete policy shown in the confirmation dialog */
  deleteDescription?: React.ReactNode
  /** Keep the confirmation visible while preventing a known-invalid delete */
  isDeleteBlocked?: boolean
  /** Additional class names */
  className?: string
  /** Extra actions to render before Cancel/Save (after the spacer) */
  extraActions?: React.ReactNode
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * EntitySheetFooter
 *
 * Standard footer for entity sheets with cancel, save, and delete actions.
 * Includes delete confirmation dialog.
 *
 * @example
 * ```tsx
 * <EntitySheetFooter
 *   mode="edit"
 *   onCancel={() => setOpen(false)}
 *   onSave={handleSave}
 *   onDelete={handleDelete}
 *   isSaving={mutation.isPending}
 *   isDirty={form.formState.isDirty}
 *   isValid={form.formState.isValid}
 *   entityName="Acme Corp"
 * />
 * ```
 */
export function EntitySheetFooter({
  mode,
  onCancel,
  onSave,
  onDelete,
  isSaving = false,
  isDeleting = false,
  isDirty = false,
  isValid = true,
  saveLabel,
  cancelLabel = 'Cancel',
  entityName,
  deleteDescription,
  isDeleteBlocked = false,
  className,
  extraActions,
}: EntitySheetFooterProps) {
  const isLoading = isSaving || isDeleting
  const canSave = mode === 'create' ? isValid : isDirty && isValid

  const defaultSaveLabel = mode === 'create' ? 'Create' : 'Save Changes'
  const finalSaveLabel = saveLabel ?? defaultSaveLabel

  return (
    <div className={cn('flex items-center gap-2 w-full', className)}>
      {/* Delete Button (Edit mode only) */}
      {mode === 'edit' && onDelete && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoading}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span className="ml-2">Delete</span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {entityName || 'this item'}?</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteDescription ?? (
                  <>
                This action cannot be undone. This will permanently delete{' '}
                {entityName ? `"${entityName}"` : 'this item'} and all associated data.
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onDelete}
                disabled={isDeleteBlocked || isLoading}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Extra Actions (before Cancel/Save) */}
      {extraActions}

      {/* Cancel Button */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onCancel}
        disabled={isLoading}
      >
        {cancelLabel}
      </Button>

      {/* Save Button */}
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={!canSave || isLoading}
      >
        {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {finalSaveLabel}
      </Button>
    </div>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { EntitySheetFooterProps }
